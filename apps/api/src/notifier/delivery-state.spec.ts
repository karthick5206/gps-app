import { claimDecision, deadBeforeRun, deadReason, dedupeKey, finalAttempts, LEASE_MS, MAX_DELIVERIES, MAX_TAKEOVERS, onJobFailure, providerRef } from './delivery-state';

describe('D6 G2 delivery state machine', () => {
  const now = new Date('2026-11-14T10:00:00Z');
  const past = new Date(now.getTime() - 1);
  const future = new Date(now.getTime() + LEASE_MS);

  it('uses the owner-approved budget (5 deliveries, 3 takeovers, 5 min lease)', () => {
    expect(MAX_DELIVERIES).toBe(5);
    expect(MAX_TAKEOVERS).toBe(3);
    expect(LEASE_MS).toBe(300_000);
  });

  it('builds one dedupe key per alert + channel + recipient (case / whitespace-insensitive recipient)', () => {
    expect(dedupeKey('a1', 'SMS', '+919800000001')).toBe('a1:SMS:+919800000001');
    expect(dedupeKey('a1', 'EMAIL', ' Ops@Example.com ')).toBe(dedupeKey('a1', 'EMAIL', 'ops@example.com'));
    expect(dedupeKey('a1', 'EMAIL', 'x@y.z')).not.toBe(dedupeKey('a1', 'SMS', 'x@y.z'));
    expect(dedupeKey('a1', 'SMS', '1')).not.toBe(dedupeKey('a2', 'SMS', '1'));
  });

  it('derives a stable, opaque provider reference from the key', () => {
    const k = dedupeKey('a1', 'EMAIL', 'x@y.z');
    expect(providerRef(k)).toBe(providerRef(k));
    expect(providerRef(k)).toMatch(/^[0-9a-f]{32}$/);
    expect(providerRef(k)).not.toContain('x@y.z');
    expect(providerRef(dedupeKey('a2', 'EMAIL', 'x@y.z'))).not.toBe(providerRef(k));
  });

  describe('claimDecision', () => {
    it.each(['SENT', 'FAILED', 'SKIPPED'] as const)('%s is final: never sent again', (status) => {
      expect(claimDecision({ status, attempts: 1, nextAttemptAt: null }, now)).toBe('done');
      expect(claimDecision({ status, attempts: 9, nextAttemptAt: past }, now)).toBe('done');
    });

    it('a QUEUED row with a live lease belongs to another worker', () => {
      expect(claimDecision({ status: 'QUEUED', attempts: 1, nextAttemptAt: future }, now)).toBe('busy');
    });

    it('an expired lease may be taken over at most 3 times, then the row is abandoned', () => {
      // attempts on a QUEUED row = runs that claimed it (1 initial claim + takeovers)
      expect(claimDecision({ status: 'QUEUED', attempts: 1, nextAttemptAt: past }, now)).toBe('takeover'); // 1st takeover
      expect(claimDecision({ status: 'QUEUED', attempts: 2, nextAttemptAt: past }, now)).toBe('takeover');
      expect(claimDecision({ status: 'QUEUED', attempts: 3, nextAttemptAt: past }, now)).toBe('takeover'); // 3rd takeover
      expect(claimDecision({ status: 'QUEUED', attempts: 4, nextAttemptAt: past }, now)).toBe('abandon');
    });

    it('a pre-rendered QUEUED row without a lease can be claimed', () => {
      expect(claimDecision({ status: 'QUEUED', attempts: 0, nextAttemptAt: null }, now)).toBe('takeover');
    });
  });

  it('final attempts = interrupted runs (one each) + provider attempts of the finishing run', () => {
    expect(finalAttempts(1, 1)).toBe(1); // first run, sent at once
    expect(finalAttempts(1, 3)).toBe(3); // first run, 3 provider tries (G3 R7: attempts = 3)
    expect(finalAttempts(2, 1)).toBe(2); // one interrupted run + this run's single try
    expect(finalAttempts(1, 0)).toBe(0); // SKIPPED: nothing was sent
  });

  describe('retry budget', () => {
    it('retries deliveries 1-4 and declares the job DEAD at the 5th', () => {
      expect([1, 2, 3, 4].map(onJobFailure)).toEqual(['retry', 'retry', 'retry', 'retry']);
      expect(onJobFailure(5)).toBe('dead');
      expect(onJobFailure(7)).toBe('dead');
    });

    it('a job redelivered beyond the budget (it never finished, e.g. it crashes the process) is DEAD without running', () => {
      expect(deadBeforeRun(5)).toBe(false);
      expect(deadBeforeRun(6)).toBe(true);
    });

    it('records a bounded reason', () => {
      expect(deadReason(5, 'db down')).toBe('dead after 5 deliveries: db down');
      expect(deadReason(6, null)).toBe('dead after 6 deliveries');
      expect(deadReason(5, 'x'.repeat(2000)).length).toBe(500);
    });
  });
});
