# Device setup guide

How to point a tracker at VeeTracer and confirm it's working.
All devices connect to **`track.mintplus.co.in`** over TCP. This name must stay DNS-only (no HTTP proxy in front of it).

| Family | Models | Port | Protocol in VeeTracer |
|---|---|---|---|
| Concox / Jimi GT06 family | GT06N, AT4, WeTrack2, **GT800**, **V5**, **VL149** (4G), **OB22** (OBD) | **5023** | `GT06` |
| Teltonika | **FMB920**, **FMB120**, **FMC130** (any FMB/FMC/FMM/FMT) | **5027** | `TELTONIKA` |
| JT/T 808 dashcams / MDVRs | **Mettax MC202**, Jimi JC4xx, other JT/T 808-2013/2019 terminals | **6808** | `JT808` |
| iTriangle AIS-140 | TS101 Basic / Advanced | **5030** | `AIS140` (built from the public AIS-140 spec; see §4) |

> **New protocol features need a real-device check.** Concox OBD / RFID / fuel-sensor packets and the whole AIS-140 decoder were built from public protocol specs, not vendor documents or captures. Before rolling a model out, connect one unit with `GATEWAY_CAPTURE=<IMEI>` enabled on the gateway (see §5) and send the capture file and any `unparsed-<protocol>.log` lines to development so the decoder can be confirmed against real frames.

## 1. Before you configure the device
1. **Register the device:** in VeeTracer, go to **Masters → Devices → Add**. Enter the IMEI (15 digits, from the label or the `IMEI#` / `getimei` reply) and pick the right model.
2. **Attach it to a vehicle:** create or open the vehicle under **Masters → Vehicles & Objects** and select the device.
3. **Check the SIM:** it needs an active data plan. Common APNs: Airtel `airtelgprs.com`, Jio `jionet`, Vi `www`, BSNL `bsnlnet`. M2M SIMs use the provider's APN.

A device that connects before it's registered appears under **Platform → Unknown Devices**, with its IMEI and the time it was last seen.

## 2. Concox / Jimi (GT800, V5, VL149, GT06N…)
Send these commands by SMS to the device's SIM number. Each is answered by SMS. On older firmware, put the device password (default `123456` or `666666`) after the command name, for example `SERVER,666666,1,…#`.

| Purpose | Command |
|---|---|
| Server (domain, port 5023, TCP) | `SERVER,1,track.mintplus.co.in,5023,0#` |
| APN | `APN,airtelgprs.com#` (use your SIM's APN) |
| Upload interval: 10 s with ignition on, 180 s off | `TIMER,10,180#` |
| Time zone India (device reports +05:30; VeeTracer converts) | `GMT,E,5,30#` |
| Check settings | `PARAM#` and `STATUS#` |
| Current location (SMS reply) | `WHERE#` |
| Restart | `RESET#` |
| Engine cut / restore (relay wired) | `RELAY,1#` / `RELAY,0#` |

Notes:
- **Time zone:** the device reports its zone at login. VeeTracer detects automatically whether the device clock is local or UTC, so either setting works. The gateway log shows `clock is local (zone applied)` or `clock is UTC (zone ignored)` for each device.
- **4G models (V5, VL149):** these send 4G packets (0xA0/0xA4). They're supported on port 5023 like the 2G ones.
- **External voltage:** models that report the vehicle supply (0x23 heartbeat or 0x94 info) show it under **External voltage** in the vehicle panel.
- **RFID card readers (driver identification):** Concox units with an RFID reader (GT800 / V5 / VL149 with the reader accessory) report each card swipe in an information packet (0x94, sub-type 0x1B). VeeTracer stores the card number as the position's **driver id** and records an `rfid` event. To have the swipe put a driver on the vehicle, enter the same card number in the driver's **RFID tag** field (**Masters → Drivers**). Card numbers are compared as hex digits without leading zeros, so `000A1B2C3D` and `A1B2C3D` match. The driver is taken off the vehicle again when the ignition goes off. If you don't know the card number, swipe it once and read the **Driver (RFID card)** field in the vehicle panel.
- **Fuel sensor (serial):** a serial fuel-level sensor on a Concox unit (0x94 sub-type 0x0D, `!AIOAU,…` text) is stored as `fuelSensorRaw` / `fuelSensorTemp`. In the vehicle's fuel settings, choose the LLS sensor source and enter a calibration table (raw value → litres).
- **OBD trackers (Concox OB22 class):** plugged into the OBD-II port, these send OBD data packets (0x8C). VeeTracer reads engine RPM, coolant temperature, ECU speed, fuel level %, ECU odometer and engine hours (`rpm`, `coolantTemp`, `obdSpeedKph`, `fuelLevelPct`, `obdOdometerKm`, `engineHours`). The latest values are shown with each following position. For fuel, choose the CAN fuel level (%) source in the vehicle's fuel settings and enter the tank capacity. Register these devices with the **OB22** model. Units (especially the odometer) still need checking against a real vehicle.
- **Not supported yet on Concox:** analog (ADC) fuel sensors. The public spec doesn't document an ADC information sub-type, so the analog fuel source (`adc1`) only works on Teltonika for now. Send a capture if you have a Concox unit with an analog input.

## 3. Teltonika (FMB920, FMB120, FMC130…)
Use **Teltonika Configurator** over USB, or SMS. In an SMS, put the SMS login and password before the command. With none set, start the SMS with two spaces.

| Setting | Configurator (GPRS → Server settings) | SMS |
|---|---|---|
| Domain | `track.mintplus.co.in` | `  setparam 2004:track.mintplus.co.in` |
| Port | `5027` | `  setparam 2005:5027` |
| Protocol | TCP | `  setparam 2006:0` |
| APN | your SIM's APN | `  setparam 2001:airtelgprs.com` |
| All at once | | `  setparam 2001:airtelgprs.com;2004:track.mintplus.co.in;2005:5027;2006:0` |
| Check | | `  getinfo` and `  getstatus` |
| Engine cut / restore (DOUT1 wired to a relay) | | `  setdigout 1` / `  setdigout 0` |

Recommended Configurator settings:
- **Data acquisition:** "On Stop" 300 s, "Moving" 10 s / 100 m / 10° angle change.
- **I/O:** enable Ignition (239), Movement (240), External Voltage (66), Battery Voltage (67), GSM Signal (21) and Total Odometer (16).
- **Optional:** Green Driving (253/254), Crash Detection (247), Unplug (252), Towing (246) and Jamming (249) appear as harsh-driving, crash, power-cut, towing and jamming alarms. iButton/RFID (78) appears as the driver id.

## 4. iTriangle TS101 (AIS-140)
AIS-140 devices must keep reporting to the **state government's backend** (the permit / emergency-response server the RTO assigns). VeeTracer is added as the **second server IP**: never replace the primary (government) server with VeeTracer. A device that stops reporting to the state backend can fail its fitness or permit check.

Configure the second server with iTriangle's configuration tool, or by SMS if your firmware supports it (the SMS syntax depends on the firmware, so check iTriangle's manual):

| Setting | Value |
|---|---|
| Second server IP / domain | `track.mintplus.co.in` (166.0.242.121 if the device only accepts an IP) |
| Second server port | **5030**, TCP |
| APN | your SIM's APN (AIS-140 units usually ship with an embedded M2M SIM and the provider's APN) |
| Live interval | 10 s (AIS-140 default) |

What VeeTracer reads (per the public AIS-140 spec):
- **Identity:** the 15-digit IMEI. Register it under **Masters → Devices** with the **iTriangle TS101** model.
- **Packets:** login, live (`L`) and history (`H`) location packets, alert packets, health (`HMP`) packets and emergency (`$EPB,EMR`) messages. History packets are stored as buffered (re-uploaded) data, so they don't trigger live alerts twice.
- **Alerts:** emergency / panic button → **SOS**; box opened or emergency wire cut → **tamper**; main battery disconnected → **power cut**; low internal battery; harsh braking, harsh acceleration and rash turning; overspeed. Ignition on/off and power restored are recorded as events.
- **Status fields:** ignition, external (main) voltage, internal battery voltage, health-packet battery %, GSM signal, satellites, HDOP/PDOP, network operator, emergency state, box-open state, cell tower, digital inputs/outputs.
- **Time:** AIS-140 devices send UTC; VeeTracer stores it as UTC.
- **Replies:** AIS-140 devices don't need acknowledgements from the second server, so VeeTracer sends none.
- **Commands:** only *Custom command*, sent as a raw text line (for example iTriangle's OTA `SET`/`GET` commands). The text and reply format depend on the firmware.

**Verify with a real device first.** The decoder handles the common vendor variations (alert ID field present or absent, vehicle registration field present or absent, 3 or 4 neighbouring cells, checksum present or absent). It hasn't been checked against a TS101 yet, so connect one unit with `GATEWAY_CAPTURE=<IMEI>` enabled and send the capture to development before rolling out.

## 4a. JT/T 808 dashcams (Mettax MC202 and similar)
Set the platform server in the dashcam's own menu or the vendor's configuration tool (the exact menu names vary by firmware).

| Setting | Value |
|---|---|
| Server / IP | `track.mintplus.co.in` |
| Port | **6808**, TCP |
| Protocol | JT/T 808 (2013 or 2019) |
| Terminal phone / device ID | Note this number: it is the device's identity in VeeTracer |

Notes:
- **Registering in VeeTracer:** enter the **terminal phone / device ID** (not the IMEI) as the device's unique ID, without leading zeros. For example, a terminal ID `013912345678` is registered as `13912345678`. If unsure, connect the device first and copy the ID from **Platform → Unknown Devices**.
- **Time zone:** the spec says GMT+8, but VeeTracer detects GMT+8, IST and UTC clocks automatically from the first live fix.
- **ADAS / DMS:** collision, lane-departure, fatigue, phone and smoking events are stored with each position (`adas`, `dms` fields). Video is covered in §4b.
- **Commands:** *Request location* (0x8201) and *Restart device* (0x8105). A custom command is read out on the dashcam speaker (0x8300 TTS), or `#<msgId>:<hex body>` sends a raw message.

## 4b. Video (JT/T 1078)
Live and recorded video from JT/T 1078 dashcams (Mettax MC202 class) plays in the web app: **Live Map → vehicle → Video** tab, the **Video** page, or **Watch video** on an ADAS / DMS alert (opens the recordings ±2 minutes around it). The mobile app's **Video** button opens the same page in the browser (sign in on the web there once).

How it works: VeeTrax asks the dashcam over its JT808 connection (0x9101 live, 0x9205 list recordings, 0x9201 playback, 0x9102 / 0x9202 stop). The dashcam then opens a **second TCP connection to port 7612** and streams H.264. The gateway turns it into HTTP-FLV; the API relays it to viewers with a short-lived signed link. A stream stops by itself 30 s after its last viewer leaves.

**Server (one-time):**
- Open **TCP 7612** inbound on the server firewall, e.g. `New-NetFirewallRule -DisplayName "VeeTrax video 7612" -Direction Inbound -Protocol TCP -LocalPort 7612 -Action Allow`. No Caddy change: viewers go through `https://gps.mintplus.co.in/api/video/...`.
- Gateway / API environment (defaults shown; restart `veetracer-gateway` and `veetracer-api` after changing):

| Variable | Default | Meaning |
|---|---|---|
| `MEDIA_PORT` | 7612 | Public TCP port dashcams stream to; `0` disables video |
| `MEDIA_PUBLIC_HOST` | track.mintplus.co.in | Host / IP sent to the dashcam in 0x9101 / 0x9201 |
| `MEDIA_HTTP_PORT` | 4110 | Gateway HTTP-FLV server, bound to 127.0.0.1 only (the API proxies it) |
| `MEDIA_MAX_STREAMS` | 8 | Concurrent device streams (protects the 4 GB server); viewers of the same channel share one stream |

**Dashcam settings:**
- Video server = the **same host** as the JT808 server (`track.mintplus.co.in`). Most firmware takes the address from the 0x9101 request, so nothing else is needed; if the firmware has its own "video server" field, enter the same host and port 7612.
- Video codec **H.264**. H.265 cannot be played in the browser (the player says so).
- Channels: usually CH1 = road camera, CH2 = driver camera, CH3–CH4 = extra cameras when fitted. The channel count comes from the dashcam (0x1003) when it answers; otherwise CH1–CH4 are shown.
- Keep a memory card inserted for recordings.

**Bandwidth:** VeeTrax requests the **sub-stream** by default: about **256–512 kbps per channel** (≈ 115–230 MB of SIM data per hour per channel). The main stream is typically 1–2 Mbps. This release is video-only (no audio).

**Permissions:** the **Video** menu (view) is granted to Admin and Manager roles (run the seed's role sync, or add it in **Roles & Permissions**; add it to User roles there if wanted). The device model must have the `video` capability (the JT808 model does) and the vehicle an active licence. Every view is written to the audit log (vehicle, channel, live / playback, duration).

**Verify with a real device first.** The media server and signalling were built from the public JT/T 1078-2016 spec, not vendor documents or captures. Connect one MC202 with `GATEWAY_CAPTURE=<terminal id>` on the gateway, start a live view and a recording search, and send `capture-jt808.log` plus the gateway log lines from `[Media]` / `[Video]` to development. To confirm: the 0x9101 answer, that media arrives on 7612 (6- or 10-byte SIM field is detected automatically), recording times from 0x1205 (device clock zone), and playback (0x9201).

## 5. Checking a device
1. **Live map:** the vehicle should leave **No data** within a minute of the device connecting.
2. **Unknown Devices:** if the IMEI shows up there, the device is connecting but isn't registered, or was registered with a different IMEI.
3. **Server logs** (support staff), in `C:\apps\veetracer\logs\veetracer-gateway.log`:
   - `[gt06] connections=… positions=…` stats every 30 s
   - `Device <IMEI> reports UTC+330 min; clock is …`: time-zone detection
   - `Unparsed … hex: …` lines, also written to `apps/api/var/logs/unparsed-<protocol>.log`. These are packets the gateway couldn't parse; send them to development.
4. **Raw capture for a specific device:** set `GATEWAY_CAPTURE=<IMEI>[,<IMEI>…]` (or `all`) for the gateway process and restart it. The first 500 frames per connection are written to `apps/api/var/logs/capture-<protocol>.log`, in both directions, as hex. Use these files to add real-device test fixtures.
5. **Before rolling out a new model or feature:** enable `GATEWAY_CAPTURE=<IMEI>` for one unit, let it run through the cases that matter (ignition on/off, an alert, a card swipe, an OBD reading, an emergency press for AIS-140), then send `capture-<protocol>.log` and `unparsed-<protocol>.log` to development. This applies especially to the Concox OBD / RFID / fuel-sensor packets and to AIS-140, which were built from public specs.
