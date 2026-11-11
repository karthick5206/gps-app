# Mobile tracker API (VeeTrax Tracker app ↔ server)

A phone is a **device** whose model protocol is `mobile` (seeded model: *VeeTrax · Mobile tracker (Android)*).
Its `uniqueId` is the mobile number in E.164 digits without `+`, e.g. `919876543210`. An admin adds it in
**Devices** first (company, vehicle / person assignment, licence); the phone then activates with that number.

Base URL: `https://<server>/api/tracker/v1` (same host as the web app). JSON bodies, UTF-8.
Errors: HTTP status + `{ "message": string }`.

## 1. Request an activation code

`POST /activate/request` — no auth.

```json
{ "mobile": "+91 98765 43210" }
```

The server normalises the number (10 digits → `91` prefix), checks that an active mobile-tracker device with that
`uniqueId` exists and belongs to a company, creates a 6-digit code valid **10 minutes** and sends it by SMS.
When SMS isn't configured, the admin sees the pending code on the device in Devices and reads it out.

`200 { "ok": true, "mobile": "919876543210", "smsSent": true | false, "expiresInSec": 600 }`
`404` number not registered · `429` asked again within 30 s.

## 2. Verify and get the tracker token

`POST /activate/verify` — no auth.

```json
{ "mobile": "919876543210", "code": "123456", "deviceName": "Samsung SM-A155F", "appVersion": "1.0.0", "platform": "android" }
```

`200`:

```json
{
  "token": "<opaque, 43+ chars>",
  "uniqueId": "919876543210",
  "objectName": "Ravi (Sales)",
  "companyName": "Acme",
  "config": { "intervalSec": 10, "stoppedIntervalSec": 60, "distanceM": 10, "maxAccuracyM": 100, "batchMax": 100 }
}
```

Activating **revokes every earlier token** of this device: the old phone's next call gets `401` with
`{ "message": "...", "code": "REVOKED" }` and must stop tracking. `401` wrong / expired code (5 attempts max).

## 3. Upload positions

`POST /positions` — header `Authorization: Bearer <token>`.

```json
{
  "positions": [
    { "t": 1760950000000, "lat": 13.0827, "lng": 80.2707, "acc": 6.5, "spd": 11.2, "brg": 271, "alt": 12,
      "bat": 83, "chg": false, "mock": false, "sos": false }
  ]
}
```

| Field | Meaning |
|---|---|
| `t` | fix time, epoch ms (UTC) — required |
| `lat`, `lng` | WGS84 degrees — required |
| `acc` | horizontal accuracy radius, metres (Android `accuracy`) |
| `spd` | speed m/s (`null`/omitted when unknown) |
| `brg` | bearing degrees 0–360 |
| `alt` | altitude metres |
| `bat` | phone battery % · `chg` charging |
| `mock` | Android reported a mock (fake GPS) location |
| `sos` | the user pressed SOS in the app (sent immediately, alone) |

Max **500** per call, oldest first. The app keeps unsent points in a local queue and retries with backoff.
`200 { "ok": true, "accepted": 12, "config": { ... } }` (config may change; the app applies it).
`401 code=REVOKED` (another phone activated) or `code=INVALID` → stop and show the activation screen.
`403 code=INACTIVE` device switched off by the admin → stop, keep the token, retry hourly.

Server side: each point becomes a `NormalizedPosition` with `protocol: "mobile"`, attributes
`accuracyM`, `batteryLevel`, `charging`, `mock`, `alarm: "sos"` (SOS). Points with `acc > maxAccuracyM` are kept as
invalid fixes (not drawn as movement); mock locations are flagged and never move the vehicle.

## 4. Status

`GET /me` — Bearer token → `{ "uniqueId", "objectName", "companyName", "config" }` (used on app start).

## 5. Moving phones to another server address (app 1.5.0+)

When the server has `TRACKER_SERVER_URL` set (for example `https://app.veetrax.com`), the activation, `/me` and upload
answers carry `"server": { "url": "https://app.veetrax.com" }`. A phone using a different address then:

1. accepts only a plain `https://host` on a domain built into the app (`veetrax.com`, `mintplus.co.in` and their
   subdomains; same list as `TRACKER_SERVER_DOMAINS` in the API), so a wrong or hijacked setting can't redirect phones;
2. calls `GET <url>/api/tracker/v1/me` with its own token (redirects not followed);
3. on a 2xx answer, uses that address for all later uploads and app requests (it survives restarts and sign-out);
   otherwise it stays and tries the same address again after an hour.

Both outcomes are in the phone's history (kind `server`, Devices → Tracker app). The batch that carried the answer was
already accepted by the old server; only the next one goes to the new address.

**A move only works when the phone's login exists on the new server**, so copy the data (sessions included) first,
then set `TRACKER_SERVER_URL` on the **old** server and restart its API. Older apps ignore the field; for them, point
the old domain at the new server instead. An invalid value is ignored with a startup warning.

The app's build address (`EXPO_PUBLIC_SERVER_URL`, default `https://app.veetrax.com`) only seeds a fresh install:
the native engine keeps the address, and the app's screens follow it.

## Attendance

All with the Bearer token. `{ "enabled": false }` when attendance doesn't cover this phone today.

- `GET /attendance` → `PhoneAttendanceDto`: check-in, state, today's unanswered time outside, whether a selfie is needed.
- `PUT /attendance/outing` `{ "leftAt", "kind": "OFFICIAL" | "PERSONAL", "note"? }`: counts until an admin decides; 409 after that.
- `POST /attendance/selfie` multipart `file` (JPEG / PNG / WebP, 8 MB): only while inside the work site and when the company turned selfies on.

The answer to `POST /positions` may carry `attention: { id, title, text }`; the app shows each id once as a notification.
