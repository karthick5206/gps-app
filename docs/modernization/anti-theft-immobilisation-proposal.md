# Anti-theft immobilisation: proposal for review

**Status: PROPOSAL ONLY. Nothing in this document is implemented. Nothing about engine stop changes until the owner approves it in writing (vehicle safety, roadmap rule "stop before anything affecting vehicle safety").**
Related decisions: Q-01 (approved), Q-25 (open) in [decision-log.md](decision-log.md). Risk R-01 in [05-technical-risk-register.md](05-technical-risk-register.md).
Owner instruction: *"Do not weaken these rules for parked vehicles. Research a safer anti-theft immobilisation workflow separately and present it for review."*

Labels used below:
- **[repo]**: verified in this repository's code or docs (file referenced).
- **[vendor: confirm]**: general industry knowledge of Concox / Teltonika / relay behaviour. Not verifiable from the repo. **Vendor documentation to confirm on a real device** before anything depends on it.
- **[legal: confirm]**: Indian regulatory point (AIS-140, CMVR / Motor Vehicles rules, insurance). Needs confirmation by the owner or counsel.

---

## 1. The rules that must stay intact (Q-01 / Q-25)

| # | Rule (as implemented) | Where [repo] |
|---|---|---|
| R1 | Vehicle must be online (`status` not `OFFLINE` / `NO_DATA`) | `engineStopBlockReason`, packages/shared/src/commands.ts |
| R2 | Telemetry ≤ 60 s old (`ENGINE_STOP_MAX_FIX_AGE_SEC`), newest of `fixTime` and `serverTime` | same |
| R3 | Speed ≤ 20 km/h (`ENGINE_STOP_MAX_SPEED_KPH`) | same |
| R4 | Never queued: if no gateway is subscribed for the device, the command is marked `FAILED` | `dispatch()` / `send()`, apps/api/src/commands/commands.service.ts |
| R5 | Re-validated before execution: gateway drops a critical dispatch older than 60 s (`criticalDispatchRejection`), and drops any queued engine stop found on reconnect (incl. legacy entries recognised by text) | apps/api/src/gateway/main.ts, tcp-server.ts `onIdentified` |
| R6 | Unknown / stale state is refused, never assumed safe | `assertEngineStopSafe` |
| R7 | Web users re-enter their password; API keys need `write:commands:critical` | `send()` |

Every option below is scored against R1–R7. An option that needs any of them relaxed is marked **not acceptable** unless the owner explicitly approves it as a new feature.

## 2. Why a parked vehicle gets refused today [repo]

1. **Positions are sparse while parked.** DEVICE_SETUP.md recommends Concox `TIMER,10,180#` (180 s with ignition off) and Teltonika "On Stop" 300 s. So a parked vehicle's last position is anywhere from 0 to 180 s (Concox) or 0 to 300 s (Teltonika) old. With a uniform request time, R2 refuses roughly **two thirds** of requests on a Concox unit and **four fifths** on a Teltonika unit.
2. **Heartbeats do not refresh telemetry.** A GT06 heartbeat (0x13 / 0x23) updates the gateway session status (ignition, `oilCut`, voltage), but it produces **no position** (apps/api/src/gateway/gt06/decoder.ts, `case 'heartbeat'`). So `LiveObject.serverTime` is not updated. Only the `vt:conn:<id>` key is refreshed (TTL 300 s, refreshed at most every 60 s, tcp-server.ts `refreshConnectionKey`). That key keeps the vehicle from being marked OFFLINE (offline-sweeper.service.ts), but it says nothing about the vehicle's current speed or position.
3. **"Request location" doesn't refresh telemetry either.** `locate` sends `WHERE#` (GT06) or `getgps` (Teltonika) (PROTOCOL_COMMANDS). The device's reply comes back as a **command response text** (GT06 0x15 / 0x21, Teltonika Codec 12 type 0x06). It is stored as the command's `response` (status ACKED) and is **not parsed into a position** (tcp-server.ts `onCommandResponse`). So today, "Request location" followed by "Stop engine" still fails R2 unless the device also happens to upload a GPS packet. **[vendor: confirm]** Some Concox firmware also uploads a 0x12 / 0x22 GPS packet when it gets `WHERE#` over GPRS, and some only answer with text.

Q-25 asked whether "connected (`vt:conn`) + last known speed 0" could stand in for fresh telemetry. This proposal recommends **not** doing that. A connection heartbeat can't tell a parked car from one that was driven away since its last position 3–5 minutes ago. This is exactly the theft case.

## 3. Relevant device facts

| Topic | GT06 (Concox / Jimi) | Teltonika FMB/FMC |
|---|---|---|
| Engine-stop text | `RELAY,1#` / `RELAY,0#` [repo] | `setdigout 1` / `setdigout 0` (DOUT1) [repo] |
| Transport | 0x80 server command with 4-byte server flag; reply carries the same flag, so replies match exactly [repo, codec.ts `encodeCommand`] | Codec 12. **No reference**: replies match the **oldest pending command** (FIFO) [repo, tcp-server.ts] |
| Reply example | `Cut off the fuel supply: Success!` [repo, codec-ext.spec.ts] | Text such as `DOUT1:1 …` **[vendor: confirm]** |
| Relay state feedback | Terminal-info bit 0x80 → `attributes.oilCut` on positions [repo, codec.ts / decoder.ts] | IO 179 → `attributes.do1` [repo, teltonika/decoder.ts] |
| Ignition | ACC bit / `ignition` [repo] | IO 239 [repo] |
| Device-side speed interlock | **[vendor: confirm]** Many Concox firmwares execute `RELAY,1#` only when GPS is fixed and speed < 20 km/h. Otherwise they reply that the cut will happen "after speed is below 20 km/h" and **hold the command on the device until that is true**. This is a device-side deferred execution, effectively a hidden queue. | **[vendor: confirm]** `setdigout` acts at once by default. Some FMB firmware accepts extra arguments (timeouts / speed condition), and there are configurable scenarios (immobiliser, DOUT control by ignition) in Configurator. |
| Force a fresh record | **[vendor: confirm]** `WHERE#` may or may not trigger a GPS packet upload | **[vendor: confirm]** `getrecord` is documented to generate and send a fresh AVL record. `getgps` only answers with text. |

**Consequence of the Concox deferred-execution behaviour [vendor: confirm]:** if a firmware holds `RELAY,1#` until the speed drops, the device can cut the engine **minutes later** with no server-side check. This is not a new risk created by this proposal. It applies to today's command too, whenever the server's view and the device's view differ. Every option below includes **classifying the ACK text** so that a "deferred" reply is shown to the user and an immediate cancel (`RELAY,0#`) is offered. See open question O-3.

## 4. Options

### Option 1: "Fresh-fix probe, then confirm" (rules unchanged)

**Flow**
1. The user taps **Stop engine** and enters their password (R7, as today).
2. The server checks that `vt:conn:<id>` exists (connected now). If not, it refuses: "not connected, engine stop is never queued" (R4). **Nothing is sent and nothing is stored for later.**
3. The server sends a **probe** that makes the device upload a real position now: Teltonika `getrecord`, Concox `WHERE#` (only if bench-proven to upload a GPS packet; otherwise see the alternatives under "Protocol" below). The probe is a non-critical command but is sent **no-queue**: it is dropped, not queued, if the device disconnects.
4. The UI shows "Asking the vehicle for its position…" for up to **45 s**.
5. A probe succeeds only if a position arrives through the **normal processor pipeline** (drift / jump filtering intact) that:
   - has `serverTime` **after** the probe was sent. This defeats stale or re-uploaded points and device clock skew.
   - is a **valid GPS fix** (`valid = true`, not `reupload`). This is stricter than today. See observation O-6.
   - has `fixTime` within 60 s of server time and not in the future (> +30 s). This guards against clock skew in either direction.
   - passes `engineStopBlockReason` unchanged (online, ≤ 60 s, ≤ 20 km/h).
6. The UI shows the fresh fix on a map: speed, ignition, satellites, address, and a live age counter. A **second explicit confirmation** follows ("The vehicle is at … , 0 km/h, ignition off. Stop the engine now?"). The confirm button is disabled as soon as the fix passes 60 s or a newer position fails the rules.
7. On confirm, the **existing `send()` path runs unchanged**. It re-checks password scope, `assertEngineStopSafe`, no-queue dispatch and the gateway's 60-s dispatch age check. The probe is only a helper *before* the critical path. It never bypasses or replaces any check.
8. After the ACK, the UI watches the next positions for `oilCut = true` / `do1 = 1`. It shows "Relay confirmed engaged" or "Acknowledged, relay state not yet confirmed".

**Safety analysis**

| Failure mode | Handling |
|---|---|
| Stale data | Probe requires a position received after the probe started; R2 still applies at send time and at the gateway |
| GPS drift (parked jitter shows a few km/h) | The processor's drift filter runs as usual. Drift only *blocks* a stop (speed > 20), it never allows one. Show satellites / HDOP so the user understands a refusal. |
| Relay engaging while moving | The vehicle could start moving between the fix and the relay action (≤ 60 s + network). This residual risk exists today as well. Mitigation: show ignition, require the second confirmation, and add device-side interlock later (Option 2). |
| Network delay | The gateway drops a dispatch older than 60 s (R5). The probe times out at 45 s. Nothing retries automatically. |
| Duplicate delivery (double click, retry, two tabs) | Single-use confirmation token bound to user + vehicle + probe; second use rejected. The existing DeviceCommand row stays the audit record. |
| Teltonika FIFO reply matching | If `getrecord` / `getgps` never answers, the later `setdigout` reply would be attributed to the probe command, and the engine-stop row would never show ACKED. Mitigation: the probe's pending entry is cleared (timed out) before the engine stop is sent, or replies are matched by content. **This must be fixed before Option 1 ships on Teltonika.** |
| Clock skew | Freshness is anchored on server receive time after the probe. Future-dated or old fixTime is rejected. |
| Device deferred execution [vendor: confirm] | ACK text classified. A "deferred" reply shows a warning and offers an immediate restore (`RELAY,0#`). |
| Probe abuse (battery / data) | Rate-limit probes per vehicle (e.g. 3 per 10 min) and audit them. |

**Rules check:** R1 ✔ R2 ✔ R3 ✔ R4 ✔ (probe and stop both no-queue) R5 ✔ (unchanged) R6 ✔ R7 ✔ (password, plus a second confirmation). **No rule is relaxed. One check (valid GPS fix after the probe) is added.**

**Changes (if approved)**
- *Shared:* a pure `probeFreshnessReason(probeStartedAt, live, now)` next to `engineStopBlockReason`, and a per-protocol `PROTOCOL_PROBE` map (`TELTONIKA: 'getrecord'`, `GT06: 'WHERE#'` pending bench proof). A `noQueue` flag on `CommandDispatch`, with the gateway re-queue skipped for it.
- *API:* `POST /objects/:id/commands/engine-stop/probe`, which checks the password and `vt:conn`, sends the probe and returns `probeId` + `startedAt`. `GET …/probe/:id` returns the latest live state and the freshness verdict. `send()` accepts an optional `probeId`. If it is present, `send()` also enforces the probe predicate. The existing checks always run.
- *Gateway:* honour `noQueue`, and fix Teltonika FIFO matching (time out or purge pending probe entries).
- *Web / mobile:* CommandsTab.tsx and apps/mobile/src/app/commands/[id].tsx get a two-step dialog (probe progress → fresh-fix card → confirm), a relay-state badge, and texts for "deferred by device".
- *Audit:* the probe, its verdict and the confirmation are recorded alongside the existing DeviceCommand audit.

**Device compatibility:** Teltonika is likely to work (`getrecord` **[vendor: confirm]**). Concox depends on whether `WHERE#` triggers a GPS upload. If it doesn't, bench-test alternatives: parse the `WHERE#` text reply (lat / lon / speed / time) into a probe sample, or temporarily switch to a short `TIMER`. The latter changes device config and risks being left in place, so it is **not preferred**. Parsing the text reply is weaker evidence than a real GPS packet, so it would need its own approval. JT808 / AIS-140 have no engine stop today and are unaffected.

---

### Option 2: Device-side interlock (defence in depth)

Configure the tracker so the relay **physically** engages only when the device itself sees speed ≈ 0 and/or ignition off, whatever the server sends.

- **Concox [vendor: confirm]:** the built-in "cut only below 20 km/h with GPS fixed" logic. Some models / relays offer an "engage at next ignition-off" mode, or a safe relay that only breaks the starter circuit (cannot stop a running engine, only prevents restart).
- **Teltonika [vendor: confirm]:** Configurator scenarios (DOUT controlled by ignition / speed conditions, immobiliser scenario), or `setdigout` with condition arguments where the firmware supports them.
- **Wiring practice [vendor: confirm]:** wire the relay on the **starter / ignition-start circuit** rather than the fuel pump or ignition run circuit. The vehicle can then never die while driving, and a thief simply can't restart it. This is the safest physical design and needs no software at all.

**Safety analysis:** this is the strongest protection against "relay engages while moving", because the decision is made on the device with zero network delay and no clock skew. **Main hazard:** device-side conditions are themselves a *deferred* execution (the device holds the cut until the condition is met). That is a device-side queue, so it must be reviewed against the spirit of Q-01. It is acceptable only if: (a) the server still applies R1–R7 at send time (unchanged); (b) the deferred state is visible to the user (ACK classification, relay-state feedback); (c) a restore is always one tap away; and (d) the owner explicitly approves the device behaviour per model.

**Rules check:** server rules unchanged ✔. Device-side hold **needs explicit owner approval** (O-3).

**Changes:** a new capability flag `engine_cut_interlock` on DeviceModel (alongside `engine_cut`), shown in the command dialog ("this tracker also refuses to cut above X km/h"). A DEVICE_SETUP.md section per model with the exact configuration. An installer checklist (relay on the starter circuit where possible). No change to engine-stop gating.

**Compatibility:** per model and firmware. **Must be bench-proven per model before the flag is set.**

---

### Option 3: "Arm on next stop" (server-held pending immobilise)

The server would store a pending immobilise and fire it once fresh telemetry shows stopped + ignition off.

**Assessment: NOT ACCEPTABLE as proposed. Recommended for rejection.**
- It is a queued engine stop under another name and violates R4 and the Q-01 decision text ("Do not execute queued engine-stop commands…").
- It executes at a time no person chose, possibly hours later, after the vehicle has changed hands (owner recovered it, a mechanic or police has it, it is parked in a dangerous spot such as a level crossing or highway shoulder).
- Failure modes: a brief GPS-fix pause or traffic-light stop with ignition on is mis-read as "parked". Ignition-off detection fails on badly wired units. A duplicate pending entry fires after a manual restore.
- If the owner ever wants this behaviour, it should be a **separate, explicitly approved feature** with its own risk analysis, a short hard TTL, a human re-confirmation at execution time (which turns it back into Option 1 or 4), and/or a device-side implementation (Option 2). Otherwise it should be left out.

**Rules check:** R4 ✘, R5 ✘ (in spirit). Not recommended.

---

### Option 4: Parking-mode breach → immobilise offer via the fresh path

Parking mode already raises `PARKING_BREACH` when an armed vehicle has ignition on, speed ≥ 8 km/h, or has moved > 150 m from where it was parked. It rings as an alarm that needs acknowledgement (packages/shared/src/parking.ts, processor/rules/evaluate.ts `parkingBreach`) [repo].

**Flow**
1. On a breach, the alarm screen (web and mobile) gets an **"Immobilise…"** action next to Acknowledge.
2. It opens the **Option 1 flow**: password, probe, fresh fix, second confirmation, standard `send()`. It does **not** send anything automatically.
3. If the vehicle is already moving above 20 km/h, the dialog says so. It shows live tracking and a "call police / share live location" action (the live-share feature exists). The user can retry when the vehicle slows. **No auto-retry and no arming.**
4. Useful by-product: a breach position is by definition **fresh** (just received), so the first attempt often passes R2 without a probe.

**Safety analysis:** same as Option 1, because it is the same path. Extra risks:
- *Alarm fatigue / panic decisions:* show speed and location prominently, and keep the second confirmation.
- *False breaches from GPS drift* (150 m threshold, ignition flicker): immobilising a truly parked car is low-risk physically, but annoying. The fresh fix shows the real state.

**Rules check:** R1–R7 ✔ (uses Option 1 unchanged).

**Changes:** alarm UI action (web alarm overlay, mobile alarm screen, push action deep-link to the command dialog). Optionally pre-start the probe when the alarm opens, so the fresh fix is ready when the user decides. That is just a locate, so it is not safety-critical. Audit links the breach alert id to the command.

---

### Option 5: Two-person / OTP-confirmed (police-assisted) stop

This option adds **authorisation** controls, not freshness controls. It doesn't solve the parked-vehicle problem by itself. It complements Options 1 and 4.

- **Second approver:** a second user (company Admin or a VeeTrax support desk) approves within N minutes. Each approval re-runs the rules at send time. Lapsed approval = nothing is sent.
- **OTP to the registered owner's mobile** (in addition to the password) for engine stop. This protects against a stolen password or a rogue employee.
- **Police-assisted mode:** the user records an FIR / complaint number and police contact. The command is still sent only when R1–R3 pass (e.g. police have stopped the vehicle, or it is at a signal or parked). It never bypasses the speed rule.

**Safety analysis:** reduces misuse and wrongful immobilisation. It adds delay, which raises the chance that the telemetry goes stale, so it must be combined with Option 1's probe *after* the approvals, immediately before send. OTP delivery uses an SMS gateway (cost: **present provider / cost before any paid service**, per roadmap rule).

**Rules check:** R1–R7 ✔ (additive).

## 5. Compliance and regulatory notes [legal: confirm]

- **AIS-140 / CMVR Rule 125H [legal: confirm]:** the mandate covers vehicle location tracking and emergency buttons for public service / commercial vehicles, reporting to the state backend. As far as known, it does **not** require or define remote immobilisation, and VeeTrax must not interfere with the device's primary (government) reporting (DEVICE_SETUP.md §4 [repo]). AIS-140 units in VeeTrax have no engine-stop command [repo, `PROTOCOL_COMMANDS.AIS140 = {}`], and none is proposed.
- **Motor Vehicles Act / vehicle modification [legal: confirm]:** fitting an immobiliser relay is an aftermarket electrical modification. Confirm the effect on type approval, vehicle warranty and insurance claims, especially if a remote cut causes an accident. Starter-circuit wiring (Option 2) reduces this risk.
- **Liability and consent [legal: confirm]:** terms of service should state that remote immobilisation is the customer's decision, only works under the safety conditions, and may be refused. Rental / finance (repossession) use cases may have consumer-protection constraints, and police involvement is advisable.
- **Audit and evidence:** every probe, confirmation, approval, command, ACK and relay-state change is already audited or should be. This supports police and insurance claims. Retention is to be confirmed with the owner.
- **Data protection (DPDP Act 2023) [legal: confirm]:** the location shared with police and the OTP to the owner's mobile are personal data processing, to be covered by the privacy notice.

## 6. Testing plan (for whichever option is approved)

**Automated (no hardware)**
1. Shared unit tests: probe predicate (stale, future-dated, re-upload, invalid fix, fix before probe start, speed 20 / 21, offline, NO_DATA), extending apps/api/src/commands/engine-stop-safety.spec.ts. All existing tests must pass unchanged, which proves R1–R7 were not touched.
2. Gateway tests (tcp-server.spec.ts): a `noQueue` probe is dropped (not queued) when the device is disconnected. Teltonika FIFO: an unanswered probe followed by `setdigout` attributes the reply to the engine stop. A critical dispatch older than 60 s is still dropped.
3. API tests: probe refused when `vt:conn` is missing. `send()` with `probeId` refuses when the probe is stale. Confirmation token is single-use (duplicate → 409). Rate limit.
4. Simulator (apps/api/src/simulator/gt06-sim.ts): add a "parked, 180 s timer" profile and a configurable `WHERE#` behaviour (text-only vs. text + GPS packet). Add "starts driving between probe and confirm" and "clock 10 min ahead / behind" scenarios. Run end to end through gateway → processor → API → web.

**Bench (real devices, before any customer use)**
Hardware: one each of Concox GT06N, V5 / VL149 (4G), GT800; Teltonika FMB920 and FMB120. Relay wired to a lamp (not a vehicle). Ignition simulated by a switch. `GATEWAY_CAPTURE=<IMEI>` on a staging gateway.

| Test | Record |
|---|---|
| `WHERE#` / `getgps` / `getrecord` while parked | Does a GPS packet arrive? How fast? Exact reply text |
| `RELAY,1#` / `setdigout 1` with GPS fixed, speed 0 | Reply text, relay latency, `oilCut` / `do1` in the next packet |
| Same with **no GPS fix** (indoors) | Executed, refused, or deferred? Reply text |
| Same while "moving" (GPS simulator or a drive on private ground at > 20 km/h, relay on a lamp only) | Device-side refusal / deferral? When does it execute after slowing? |
| Deferred command, then `RELAY,0#` | Does restore cancel the pending cut? |
| Power cycle / reconnect with a deferred command pending | Does the device remember it after reboot? (safety-critical finding) |
| Teltonika scenario / interlock config | Behaviour per firmware version |

Results go into DEVICE_SETUP.md per model and decide the `engine_cut_interlock` flag (Option 2) and the probe text per protocol (Option 1).

**Vehicle test (after bench, owner approval):** one company vehicle on private ground, relay on the **starter circuit**, with a driver aware of the test.

## 7. Recommendation and phased plan

**Recommend Option 1 (fresh-fix probe + second confirmation) together with Option 4 (parking-breach → immobilise offer through the same path).** Option 2 (device-side interlock / starter-circuit wiring) follows as defence in depth once bench data exists. **Reject Option 3.** Keep Option 5 as an optional add-on (OTP / second approver) if the owner wants stronger authorisation.

Why this keeps the strict rules intact: Option 1 does not change `engineStopBlockReason`, the 60 s / 20 km/h limits, the no-queue dispatch or the gateway re-check. It only gets the device to produce the fresh telemetry those rules already demand, then hands over to the unchanged critical path. Option 4 reuses that path from the alarm. Q-25 then needs no relaxation: the "connected + last speed 0" shortcut is not needed.

| Phase | Scope | Gate |
|---|---|---|
| 0 | Owner reviews this document, answers the open questions | **Owner approval** |
| 1 | Bench tests (§6) on Concox and Teltonika; document reply texts, probe behaviour, deferred execution | Results reviewed with owner |
| 2 | Option 1 behind a feature flag (off by default): probe endpoint, `noQueue`, Teltonika FIFO fix, ACK classification ("deferred" warning + restore), relay-state badge, two-step dialog. Tests §6. Staging only. | Owner approval to enable per company |
| 3 | Option 4: alarm-screen action (web and mobile), optional pre-started probe | Owner approval |
| 4 | Option 2: per-model interlock configuration, `engine_cut_interlock` flag, installer guide (starter-circuit wiring) | Per-model bench proof + owner approval of device-side hold (O-3) |
| 5 (optional) | Option 5: OTP / second approver | Owner approval; SMS provider cost presented first |

No production deployment at any phase without explicit approval (roadmap rule).

## 8. Open questions for the owner

- **O-1** Is a **second explicit confirmation after a fresh fix** acceptable as the standard engine-stop flow for *all* vehicles, or only when the first attempt is refused for stale telemetry?
- **O-2** Probe wait time (proposed 45 s) and probe rate limit (proposed 3 per 10 min per vehicle)?
- **O-3** Concox firmware may **hold** `RELAY,1#` on the device until speed < 20 km/h [vendor: confirm]. Is a device-side hold acceptable at all? If not, should VeeTrax automatically send `RELAY,0#` when the reply says "deferred", or warn the user and let them choose?
- **O-4** If `WHERE#` on Concox only answers with text (no GPS packet), may a parsed text reply count as fresh telemetry (weaker evidence), or must those models keep today's behaviour?
- **O-5** Should installers be required to wire immobiliser relays on the **starter circuit** (prevents restart, never stops a running engine)? This would change installer guidance and possibly customer contracts.
- **O-6** Observation for review, no change proposed: `engineStopBlockReason` accepts `serverTime` as telemetry freshness. A non-GPS event position (e.g. RFID / OBD / IO event, marked invalid) also refreshes `serverTime` and may carry a stale or zero speed (to verify in position-processor.ts). Should the existing rule also require a valid GPS fix ≤ 60 s? (That would be stricter, never weaker.)
- **O-7** Do you want OTP-to-owner or a second approver (Option 5)? If so, the SMS provider and cost need to be presented first.
- **O-8** Regulatory / legal confirmation of §5 (insurance, liability wording, finance-repossession use).
- **O-9** Q-25 can stay "keep strict". Do you agree to close Q-25 as "keep strict; parked vehicles are handled by the probe workflow (this document)" once Phase 2 is approved?
