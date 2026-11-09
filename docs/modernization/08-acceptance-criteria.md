# 08 — Acceptance Criteria

Branch `feature/modernization-phase0` · 2026-11-09 · Proposal for review. Each criterion must be demonstrable by an automated test or a recorded screenshot/recording on the isolated instance (synthetic data only).

## Global (every phase)
- G-1 Existing tests pass. New tests cover the change ([09](09-test-strategy.md)).
- G-2 No existing route, report type, API field or mobile behaviour is removed or changed incompatibly (contract check on changed endpoints).
- G-3 Light (Teal) and Dark themes verified; Plum and Sky spot-checked; 1440 px, 768 px and 390 px.
- G-4 Keyboard operable. Visible focus. axe shows no serious violations on changed screens. Text and UI contrast meet WCAG AA.
- G-5 Loading, empty, partial-data, error and permission-denied states exist for each changed screen.
- G-6 Before/after screenshots attached to the PR (the capture script from Phase 2 is reusable).
- G-7 No secrets or production data in code, fixtures or screenshots.
- G-8 Logo asset unchanged (byte-identical files in `brand/logo`, `apps/web/public`, mobile assets).

## S0 Safety track
| ID | Criterion |
|---|---|
| S0-1 | An engine-stop requested for an OFFLINE or stale vehicle is either refused or queued with the approved TTL. On reconnect it is delivered **only if** the latest position is fresher than the approved window **and** speed ≤ the limit; otherwise it is dropped and recorded FAILED with a reason. Simulator test: reconnect at 60 km/h → not delivered. |
| S0-2 | Every command state change (requested, queued, delivered, dropped, cancelled, expired) is audited with actor and timestamp. |
| S0-3 | With `NODE_ENV=production`: startup fails if dev echo is enabled; webhook/relay URLs to loopback, private and link-local addresses are rejected (tests). |
| S0-4 | The backup includes uploaded files. A restore into an empty environment is performed and documented with timings. |
| S0-5 | Concurrent confirmation of the same UPI claim results in exactly one fulfilment and one invoice (concurrency test). Rejects are audited. |
| S0-6 | The seed refuses to create a Super Admin with the default password when `NODE_ENV=production`. |

## P1 Design system
- P1-1 Inter loads (network panel shows the font; computed `font-family` resolves to Inter) in web and is used consistently.
- P1-2 Token values for Teal/Plum/Sky/Light/Dark preserved except the documented contrast adjustments approved in [07](07-design-system.md).
- P1-3 Status colours identical in meaning across map, cards, charts and badges. Status is never conveyed by colour alone.
- P1-4 `/login` initial JS no longer includes MapLibre or non-active locale bundles (baseline: 744 KB gz → target ≤ 350 KB gz).
- P1-5 Shared components (KPI card, chart kit, PeriodPresets, ScopeBar, DataTable with column chooser and phone cards) documented with examples in both themes.
- P1-6 CI runs typecheck, lint, unit tests and the web build on every PR.

## P2 Reports Hub
- P2-1 Search finds a report by name, group or description keyword; favourites and recents persist per user.
- P2-2 For every one of the 31 types, the rows and totals for a fixed synthetic dataset are **identical** before and after the change (golden tests).
- P2-3 All timestamps are in the company time zone and the header shows the zone. A browser in a different zone sees the same values.
- P2-4 Key types (Summary, Consolidated, Trips, Over-speed, Alerts, Event summary, Engine hours) show a KPI strip and one chart. Each chart has a table/text alternative.
- P2-5 Trip, stop, over-speed and alert rows open History at the matching window (deep link round trip test).
- P2-6 A schedule stores report options; the emailed file equals the on-screen run for the same period. "Send test to me" emails only the caller.
- P2-7 Ad-hoc runs and exports appear in "My recent runs" with re-run and (if retained) re-download. Users see only their own runs unless permitted.
- P2-8 Export shows progress and a clear failure reason with retry.

## P3 Dashboard & live
- P3-1 Every KPI has a tooltip definition, a period label and a comparison label. Numbers match the corresponding report for the same period (test).
- P3-2 "Needs attention" counts equal the destination lists they link to.
- P3-3 Live list and drawer show freshness (live / delayed / stale) using documented thresholds. A position older than the threshold is never shown as live.
- P3-4 Map legend explains every marker type shown.
- P3-5 DMS splits cabin and road events. Counts are unchanged versus the current page for the same filters.
- P3-6 Scorecard penalty breakdown sums to 100 − score. The scoring formula is unchanged (golden test).
- P3-7 Routine alerts no longer cover header controls. Critical alerts are always delivered.

## P4 Customer self-service & security
- P4-1 A user cannot grant a role or permission they do not hold; built-in roles cannot be edited; users cannot change their own roles (tests reproduce the 2026-11-09 probe and now fail as intended).
- P4-2 API keys cannot exceed the creator's scope or permissions.
- P4-3 Logging out or revoking a session disconnects its sockets within 5 s.
- P4-4 Template test-send requires edit permission and is rate-limited.
- P4-5 Company locale, units and date-format settings apply to web and exports.

## P5 Super Admin & commercial
- P5-1 Platform overview shows only reliably computed metrics, each with a definition.
- P5-2 Every licence correction, allocation, reclaim and suspension records actor, reason and before/after in the audit log; the Super Admin can search audit across tenants.
- P5-3 Payment reconciliation lists orders, attempts, payments, invoices and credit notes, and flags double payments.
- P5-4 Seat transfer behaviour is identical on both move paths per decision Q-05.
- P5-5 Licence validity changes only after verified payment or an audited admin action (tests for webhook, callback, offline, UPI paths).

## P6 Mobile & integrations
- P6-1 The customer app stays signed in offline or on 5xx/timeouts; it signs out only on a definitive 401 after refresh failure.
- P6-2 The tracker dead-letters a rejected batch and continues uploading later points.
- P6-3 Re-pairing requires the pairing code; the lookup endpoint reveals no personal data.
- P6-4 The public API has an OpenAPI document generated from code; examples work against the isolated instance.

## P7 Reliability & scale
- P7-1 A poison message goes to a DLQ; healthy points continue; a replay tool re-processes it.
- P7-2 No ACKed position is lost during a simulated 60-minute processor outage at 1,000 positions/s.
- P7-3 At 2,000 simulated devices: dashboard p95 < 500 ms; reports for 7 days p95 < 3 s; live update latency < 2 s (product target).
- P7-4 Security headers present; refresh token not readable by JS; login lockout cannot be triggered for another user's account by email alone.
- P7-5 Every request has a correlation ID across API, processor and notifier logs; errors reach the error tracker.
- P7-6 A DR runbook is executed once end to end, with measured RTO/RPO.
