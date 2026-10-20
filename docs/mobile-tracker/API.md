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
