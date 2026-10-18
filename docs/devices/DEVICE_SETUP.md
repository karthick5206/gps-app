# Device setup guide

How to point a tracker at VeeTracer and confirm it's working.
All devices connect to **`track.mintplus.co.in`** over TCP. This name must stay DNS-only (no HTTP proxy in front of it).

| Family | Models | Port | Protocol in VeeTracer |
|---|---|---|---|
| Concox / Jimi GT06 family | GT06N, AT4, WeTrack2, **GT800**, **V5**, **VL149** (4G) | **5023** | `GT06` |
| Teltonika | **FMB920**, **FMB120**, **FMC130** (any FMB/FMC/FMM/FMT) | **5027** | `TELTONIKA` |
| iTriangle AIS-140 | TS101 Basic / Advanced | 5030 (planned) | `AIS140`: decoder waiting for iTriangle's protocol document |

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

## 4. iTriangle TS101 (AIS-140): pending
The decoder needs iTriangle's protocol document or sample packets: login, NR/live, history, emergency and health packets. Until then, AIS-140 devices can't be connected.

## 5. Checking a device
1. **Live map:** the vehicle should leave **No data** within a minute of the device connecting.
2. **Unknown Devices:** if the IMEI shows up there, the device is connecting but isn't registered, or was registered with a different IMEI.
3. **Server logs** (support staff), in `C:\apps\veetracer\logs\veetracer-gateway.log`:
   - `[gt06] connections=… positions=…` stats every 30 s
   - `Device <IMEI> reports UTC+330 min; clock is …`: time-zone detection
   - `Unparsed … hex: …` lines, also written to `apps/api/var/logs/unparsed-<protocol>.log`. These are packets the gateway couldn't parse; send them to development.
4. **Raw capture for a specific device:** set `GATEWAY_CAPTURE=<IMEI>[,<IMEI>…]` (or `all`) for the gateway process and restart it. The first 500 frames per connection are written to `apps/api/var/logs/capture-<protocol>.log`, in both directions, as hex. Use these files to add real-device test fixtures.
