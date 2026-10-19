/**
 * Code samples for the Developer API docs tab. Developer reference material stays in English (it mirrors the
 * OpenAPI document served at /api/v1/openapi.json).
 */
export const apiBase = () => `${window.location.origin}/api`;

export const CURL_VEHICLES = (base: string) => `curl -H "Authorization: Bearer vtx_live_XXXXXXXX" \\
  "${base}/v1/vehicles?limit=100"`;

export const CURL_POSITIONS = (base: string) => `curl -H "Authorization: Bearer vtx_live_XXXXXXXX" \\
  "${base}/v1/vehicles/<vehicleId>/positions?from=2026-10-18T00:00:00Z&to=2026-10-19T00:00:00Z&limit=5000"

# Next page: repeat with &cursor=<meta.nextCursor> until nextCursor is null`;

export const CURL_COMMAND = (base: string) => `curl -X POST -H "Authorization: Bearer vtx_live_XXXXXXXX" \\
  -H "Content-Type: application/json" -d '{"type":"locate"}' \\
  "${base}/v1/vehicles/<vehicleId>/commands"`;

export const RESPONSE_SAMPLE = `{
  "data": [
    { "id": "6f1c…", "name": "TN 01 AB 1234", "plateNumber": "TN01AB1234", "type": "VEHICLE",
      "branch": { "id": "…", "name": "Chennai" }, "device": { "imei": "358899051234567", … } }
  ],
  "meta": { "count": 1, "nextCursor": null }
}`;

export const ERROR_SAMPLE = `HTTP/1.1 429 Too Many Requests
Retry-After: 17

{ "error": { "status": 429, "code": "rate_limited", "message": "Rate limit exceeded; retry in 17 s" } }`;

export const WEBHOOK_SAMPLE = `POST /your/webhook HTTP/1.1
Content-Type: application/json
User-Agent: VeeTrax-Webhooks/1.0
X-VeeTrax-Event: alert.created
X-VeeTrax-Event-Id: alert.created_2b6e…
X-VeeTrax-Delivery: 9a4d…
X-VeeTrax-Signature: t=1760870400,v1=5f2c…

{ "id": "alert.created_2b6e…", "type": "alert.created", "createdAt": "2026-10-19T10:00:00.000Z",
  "companyId": "…", "data": { "vehicleId": "…", "vehicleName": "TN 01 AB 1234", "type": "OVERSPEED",
  "severity": "WARNING", "lat": 13.0827, "lng": 80.2707, … } }`;

export const VERIFY_NODE = `// Node.js (Express): use the raw body, not re-serialised JSON.
const crypto = require('node:crypto');

function verifyVeeTrax(rawBody, header, secret, toleranceSec = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const ts = Number(parts.t);
  if (!ts || Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(ts + '.' + rawBody).digest('hex');
  const given = Buffer.from(parts.v1 || '', 'hex');
  return given.length === 32 && crypto.timingSafeEqual(given, Buffer.from(expected, 'hex'));
}

app.post('/veetrax/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!verifyVeeTrax(req.body.toString('utf8'), req.get('X-VeeTrax-Signature') || '', process.env.VEETRAX_WEBHOOK_SECRET)) {
    return res.sendStatus(401);
  }
  const event = JSON.parse(req.body);
  // De-duplicate on event.id (retries send the same id), then answer 2xx quickly.
  res.sendStatus(204);
});`;

export const VERIFY_PYTHON = `# Python (Flask)
import hashlib, hmac, os, time
from flask import Flask, request, abort

app = Flask(__name__)
SECRET = os.environ["VEETRAX_WEBHOOK_SECRET"].encode()

def verify_veetrax(raw_body: bytes, header: str, tolerance: int = 300) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
    ts = int(parts.get("t", "0"))
    if not ts or abs(time.time() - ts) > tolerance:
        return False
    expected = hmac.new(SECRET, f"{ts}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))

@app.post("/veetrax/webhook")
def webhook():
    if not verify_veetrax(request.get_data(), request.headers.get("X-VeeTrax-Signature", "")):
        abort(401)
    event = request.get_json()
    return "", 204`;
