# E5 WP 5.5: sim scenarios and server integration check (2026-11-12)

Branch `etms/e5-sim` from `main` ed2b101. Synthetic data only, scratch database `veetrax_e5s_20261112121906_test`
(dropped), private Valkey db 14 (flushed), no outbound push / SMS (`PUSH_PROVIDER=fake`, `SMS_PROVIDER=console`).

Command: `E3H_PG_URL=… npm run etms:e5 -w @veetracer/api` (676 s; harness: `apps/api/scripts/etms-e2e/README.md`).

| Criterion | Passed | Failed | Pending | Verdict |
|---|---|---|---|---|
| etms-on-time | 17 | 0 | 1 | PASS* |
| etms-no-show | 18 | 0 | 1 | PASS* |
| etms-offline-driver | 17 | 0 | 1 | PASS* |
| R6 (shuffled + duplicated replay converges) | 6 | 0 | 0 | PASS |
| NOTIFY (relay → notifier → fake push) | 19 | 0 | 0 | PASS |

77 passed, 0 failed, 3 pending: the three pending checks are known defect D1 below (`--known-defects` makes them fail).

What ran through the real API: dispatcher booking + publish; push tokens via `/auth/push-token`; relay pass
(TRIP_ASSIGNED, TRIP_STARTING_SOON); driver `/me`, duty start, `/trips`, detail (names, no contact), ACKNOWLEDGE, online
start (a 10-min-old start → 409 STALE_COMMAND), per-stop events (ARRIVED / BOARDED / NO_SHOW / DEPARTED / DROPPED /
REPORT_DELAY / COMPLETE_TRIP) while sim-trip drove the van through `vt:positions` and the v1.8 tracker; an early NO_SHOW →
REJECTED WAIT_NOT_ELAPSED, then accepted after the 5 min wait; REPORT_DELAY → TRIP_DELAYED only to the passenger still
waiting; offline queue for two stops replayed shuffled (seed 20261112), every second event twice, batches of 3, then the
whole queue again (all DUPLICATE); each clientEventId stored once; `/driver/v1/sync` returns every stored outcome; final
state of etms-offline-driver equals etms-on-time's; every notification queued a PUSH row that the notifier sent (SENT,
provider fake); push payload exactly `{ kind, tripId, notificationId }` on channel `trip`, no names; inboxes list them;
no SMS; I2: the finished trip no longer blocks erasure.

## Integration defects

- **D1 (High, open, not fixed: state-machine change needing review).** The v1.8 tracker auto-completes an ETMS trip
  (`closedBy AUTO`) when the van enters the last stop's radius (`planned-trips/tracker/evaluate.ts`). The driver API then
  treats the trip as closed (`driver-rules.ts decide`: not OPEN → `LATE TRIP_CLOSED`), so the driver's ARRIVED / DROPPED at
  the office are LATE and the riders stay **BOARDED on a COMPLETED trip**; COMPLETE_TRIP is DUPLICATE. The dispatcher
  outcome endpoint still accepts outcomes on a COMPLETED trip, so only the web can fix the seats. Seen in all three
  scenarios. Options for the owner / Lead: accept passenger outcomes (DROPPED, and NO_SHOW / BOARDED for seats still
  PENDING) on a trip closed `AUTO` within a grace period; or let the tracker not auto-close ETMS trips while seats are
  BOARDED (close on driver COMPLETE_TRIP or the timeout sweeper).
- **D1b (High, by code reading, not run).** Same cause: a driver who is offline when the trip auto-completes loses every
  queued outcome on reconnect (all LATE). The scenario format refuses an offline window that reaches the office for that
  reason.
- **D2 (Low / question).** The `Transport admin` role template has no `drivers` edit, so a transport admin cannot give a
  driver a login (`POST /drivers/:id/login` → 403). The harness seeds driver logins directly. Intended?
- Observation (by design, QA B8): TRIP_STARTING_SOON is only produced while the trip is SCHEDULED; a trip started within
  one relay tick (30 s) of publishing sends none.

## Fixed in this WP

- **I2:** `assertNoOpenBookings` ignores bookings whose seats are settled (DROPPED / NO_SHOW / CANCELLED) or whose trip is
  COMPLETED / INCOMPLETE / CANCELLED (DB test + scenario check). No migration; booking status itself still stays ASSIGNED.

## Update after the D1 / D1b fix (Lead decision, same day)

Commits d5f1407 (server), b509bfa (mobile banner), 38d9d68 (harness). Re-run 20261112125054 with :
**80 passed, 0 failed, 0 pending** (etms-on-time 18, etms-no-show 19, etms-offline-driver 18, R6 6, NOTIFY 19). The three
D1 checks now pass: the driver's office DROPPED taps are ACCEPTED with  and every rider ends DROPPED (or
NO_SHOW); the trip stays COMPLETED (closedBy AUTO).

- **Server:** for  (6 h) after a trip is COMPLETED, DROPPED, NO_SHOW and a BOARDED dated
  before the close go through the normal rules and R6 ordering, stored with  and audited
  ( in the audit details). ARRIVED / DEPARTED / reports and anything after the grace stay LATE TRIP_CLOSED,
  a definitive per-item answer. Dispatcher path unchanged.
- **DB tests** (): inside the grace accepted; outside refused with a stored LATE (a resend is
  DUPLICATE of LATE); offline driver reconnecting after the auto-complete with a shuffled + duplicated queue: 0 lost.
- **Mobile:** LATE items were already kept with their code; the sync banner now says "N not applied: trip closed" instead
  of "All actions synced".
- **Remaining gap (for the Lead):** once a trip is closed the driver detail hides the manifest (, L4), so an app that refetches the trip after the auto-complete no longer shows Dropped buttons; taps
  already queued, or made from the still-open screen, are applied. Showing unsettled seats during the grace would relax
  the closed-trip manifest rule and was not changed.
- D1b is no longer open; D2 goes to the owner (Lead).
