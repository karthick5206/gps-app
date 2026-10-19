# Data forwarding (relay)

Super Admin → **Platform → Data forwarding** (menu `sa_relay`) sends a copy of the data VeeTrax receives from
devices to other servers. Use it to:

- send AIS-140 data to a **state government backend** as well,
- run VeeTrax **in parallel with another tracking platform** (migration, trial),
- give a **partner** a live copy of positions.

VeeTrax keeps handling the device itself (ACKs, commands, alerts). Forwarding never blocks or slows that: writes are
asynchronous and every buffer is bounded (oldest data dropped first).

## Target types

| Type | Runs in | What the target gets |
| --- | --- | --- |
| **Raw TCP** | gateway | The device's original bytes, unchanged, on one TCP connection **per device connection** — as if the device were connected there directly. |
| **HTTP JSON** | notifier | Signed `POST`s of decoded positions (optionally alerts), in batches. |

Raw UDP and MQTT are not supported (UDP would need frame-level datagrams; no MQTT client library is installed).

### Raw TCP

- The upstream connection opens once the device has identified itself (GT06 login, Teltonika IMEI, JT/T 808
  register / authentication, AIS-140 login). Everything the device sent up to and including that point (max 16 KB) is
  **replayed first on every (re)connect**, so the upstream always sees a complete session.
- Replies from the upstream are **read and discarded** — VeeTrax answers the device. *Pass replies to the device* (off
  by default) writes them to the device too; it is honoured **only for AIS-140** connections, whose ACKs are short
  text lines that devices tolerate twice. Never for GT06 / JT/T 808 / Teltonika: duplicate binary ACKs (serials, flow
  numbers, record counts) would corrupt the session. Use it only when the other server must send commands (e.g. the
  state backend's SET commands) to the device.
- Upstream down: chunks are buffered per device connection (`RELAY_BUFFER_KB`, default 64 KB, and
  `RELAY_BUFFER_FRAMES`, default 500 chunks; oldest dropped), reconnect with backoff 1 s → 60 s, TCP keep-alive 30 s.
  When the device disconnects, the upstream connection is closed after the queued bytes are flushed.
- Per-position filters do not apply (bytes are copied as they are). The replayed login chunk may carry positions, so
  after an upstream reconnect those can arrive twice.
- At most `RELAY_MAX_SOCKETS_PER_TARGET` (default 5,000) upstream connections per target per gateway; further devices
  are not forwarded (counted as dropped, shown as an error).

### HTTP JSON

- Up to 100 items per POST, a partial batch after 5 s at the latest. Retries with backoff (1, 2, 5, 15, 30, 60 s, then
  every 60 s) keep the order; while failing, up to `RELAY_HTTP_QUEUE` (default 10,000) items are kept per target in
  memory (oldest dropped). A notifier restart loses what was queued.
- Body:

```json
{
  "target": { "id": "…", "name": "Partner" },
  "sentAt": "2026-10-20T06:30:05.120Z",
  "positions": [{ "protocol": "gt06", "uniqueId": "359647091912738", "fixTime": "…", "receivedAt": "…", "lat": 13.08, "lng": 80.27,
                  "speedKph": 42, "course": 90, "altitude": null, "satellites": 9, "valid": true, "ignition": true, "attributes": {} }],
  "alerts": [{ "id": "…", "companyId": "…", "objectId": "…", "type": "OVERSPEED", "message": "…", "occurredAt": "…" }]
}
```

- Headers: `X-VeeTrax-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">` (same scheme and verification as
  webhooks, secret under *Show secret*), `X-VeeTrax-Relay-Target: <id>`, and `Authorization: Bearer …` or `Basic …`
  when configured. Any 2xx counts as success; redirects are not followed. *Test connection* sends one sample batch
  with `"test": true`.
- Filters: **Live positions only** skips history / re-uploaded records (`attributes.reupload`), **Valid GPS fixes
  only** skips positions without a fix. **Include alerts** adds alerts (scopes All / Company / Devices; not for a
  Protocol scope, alerts carry no protocol).

## Scope

All devices, one company, selected devices (max 1,000) or one protocol (`gt06`, `teltonika`, `jt808`, `ais140`).
Company and device scopes are resolved to IMEIs by the API, which publishes the active rule set to Valkey
(`vt:relay:rules` + pub/sub `vt:relay:invalidate`) on every change and every 5 minutes (so a device moved to another
company is picked up). The gateway stays database-free; rule changes also apply to open device connections.

## Safety

- **Loop guard**: a target that is VeeTrax itself — `localhost` / loopback, this server's interface addresses, or a
  host in `RELAY_OWN_HOSTS` / `MEDIA_PUBLIC_HOST` / `WEB_URL` — on a device or media port is refused when saving and
  again by the gateway before every connect.
- **SSRF guard**: in production private / loopback addresses are refused unless `RELAY_ALLOW_PRIVATE=true`; HTTP
  targets must be `https://` (webhook URL rules, DNS re-checked at connect time).
- At most `RELAY_MAX_TARGETS` (default 20) targets. Create / update / delete are written to the audit log. Each target
  has an on/off switch.

## Status

Each gateway / notifier reports per-target counters in its heartbeat (upstream connections, chunks / items and bytes
sent, queued, dropped, last success, last error, recent errors). The page sums them over instances and refreshes every
10 s. System Health raises a **WARN** (`relay.<id>`) when a target has had no success for more than 5 minutes.

## Forwarding AIS-140 data to a state backend

1. Ask the state transport department (or its VLT backend operator) for the server **host and port** and confirm that
   they accept data relayed by a third-party server. **Most states require the device itself to report to the
   government server as its primary (or second) IP** — the device's own IP slots are the official route; relaying is
   a supplement (e.g. while the device's second slot is unused or during migration). The vehicle owner must confirm
   this with the state.
2. Platform → Data forwarding → **Add target**: type *Raw TCP*, host and port of the state server, scope *One
   protocol → AIS-140* (or the company / devices concerned). Leave *Pass replies to the device* off unless the state
   server must send commands to the devices.
3. *Test connection*, then check that the state portal shows the vehicles (login packet, then location packets in the
   state's format — the bytes are exactly what the device sent).

## Mirroring to another tracking platform

- Same protocol on the other platform (e.g. it also speaks GT06 / Teltonika): *Raw TCP* to its device port, scope the
  company or devices being migrated. The other platform sees the devices as directly connected (it cannot send
  commands; its replies are discarded).
- Platform with an HTTP API: *HTTP JSON* to its endpoint, with the token it issued (Bearer or Basic).

## Environment

| Variable | Default | |
| --- | --- | --- |
| `RELAY_MAX_TARGETS` | 20 | targets in total |
| `RELAY_MAX_SOCKETS_PER_TARGET` | 5000 | upstream connections per Raw TCP target per gateway |
| `RELAY_BUFFER_KB` / `RELAY_BUFFER_FRAMES` | 64 / 500 | per device connection while the upstream is down |
| `RELAY_HTTP_QUEUE` | 10000 | items per HTTP target while it fails |
| `RELAY_ALLOW_PRIVATE` | false | allow private targets in production |
| `RELAY_OWN_HOSTS` | — | extra names / IPs of this deployment for the loop guard (e.g. the public IP) |
| `RELAY` | — | `off` stops the API from republishing rules every 5 minutes |
