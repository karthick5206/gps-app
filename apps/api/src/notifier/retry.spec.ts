import { withRetries } from './retry';

describe('notifier retries', () => {
  it('succeeds after transient failures', async () => {
    let calls = 0;
    const result = await withRetries(async () => {
      calls++;
      if (calls < 3) throw new Error('SMTP timeout');
    }, 3, [1, 1]);
    expect(result).toEqual({ error: null, attempts: 3 });
  });

  it('gives up after 3 attempts with the last error', async () => {
    let calls = 0;
    const result = await withRetries(async () => {
      calls++;
      throw new Error(`fail ${calls}`);
    }, 3, [1, 1]);
    expect(calls).toBe(3);
    expect(result).toEqual({ error: 'fail 3', attempts: 3 });
  });
});
