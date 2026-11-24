# Jimi IoT JC400 / JC261 4G dashcams: integration notes

Our own notes, written from the vendor's *Communication Protocol (4G Car DVR) V1.2.8* and *Command List V5.0.6*.
The vendor documents are confidential (licensed to the supplier, Intelex Private Limited) and are **not** stored in
this repository; ask the project owner for them.

## Transport
- TCP, Concox GT06 framing (`78 78` short / `79 79` long, CRC-ITU, `0D 0A`), so the devices use the **GT06 port 5023**
  (`gateway/gt06`). Login 0x01, heartbeat 0x13 and location 0x22 are plain GT06.
- Device model in the platform: **Jimi · JC400 / JC261 dashcam** (protocol GT06, profile `JIMI_DVR` in `prisma/seed.ts`).

## Packets added for these devices (v1.24.0)
| Packet | Content | Decoder output |
|---|---|---|
| 0x95 alarm | FFFF · version · date · gps byte · lat · lng · **course/status before a 2-byte speed** · supply voltage (/10 V) · alarm type · alarm value (speed for over-speed) · uploaded clip names (ASCII, comma separated) | position with `alarm` / `adas` / `dms` / `event` (same names as JT/T 808), `dvrAlarm` (hex code), `mediaFiles`, `overspeedKph`, `seatbelt`, `door`, `oilCut`, `videoAlarm` |
| 0x37 location | as 0x22 with a 2-byte MNC when bit 15 of the MCC word is set; upload mode 0x1B = DVR event | normal position |
| 0x94 sub-types | 0x07 UUID, 0x08 firmware version, 0x0A IMEI/IMSI/ICCID, 0x0E fuel sensor (value /100, unit height / % / V) | `fuelLevelPct` / `fuelSensorRaw` / `adc1`, session firmware |
| 0x9B module | 0x03 temperature (ASCII or 3C-framed /10), 0x05 driver card reader (date · status 0 logout / 1 login / 2 illegal · card text) | `temp1`; card login → `driverId` (event `rfid`), logout / illegal → events |
| 0x9C | QCVN31 (Vietnam) data | acknowledged, not decoded |

Alarm map: `DVR_ALARMS` in `gateway/gt06/decoder.ts`. New DMS names `yawn`, `lookDown`, `calibrationFail` map to
DRIVER_FATIGUE / DRIVER_DISTRACTED / CAMERA_FAULT in `processor/rules/evaluate.ts`. Seat belt has no alert type yet
(attribute `seatbelt` + events `seatbeltOn` / `seatbeltOff` only).

## Pointing a camera at our servers (command list, sent by SMS or platform command)
Order matters (vendor note): switch to the integrated mode first, then HTTP / RTMP, then TCP (the device restarts).
1. `COREKITSW,0`, integrated (third-party platform) mode.
2. `UPLOAD,http://track.veetrax.com/dvr/upload`: event photo / clip upload (v1.25.0). HTTPS also works: `https://app.veetrax.com/api/dvr/jimi/upload`.
3. `RSERVICE,103.176.85.69:1935/live`: RTMP live video server (MediaMTX, v1.25.0).
4. `SERVER,0,103.176.85.69,5023` (live) or `SERVER,1,track.mintplus.co.in,5023` (demo): TCP server, then the device restarts.
Optional: `UPLOADSW,<event>,ON` (e.g. CRASH, CLOSEEYES, FORWARDCOLLISION) so event clips upload automatically.

Useful commands: `VERSION`, `STATUS`, `PARAM`, `REBOOT`, `Picture,in|out|inout`, `Video,in|out|inout,3s..10s`,
`RTMP,ON|OFF,IN|OUT|INOUT,<minutes>`, `UPLOADFILE,<clip name>`, `UPLOADSW,<event>,ON|OFF|1|2`, `RELAY,<0|1>`.
Clip names: `EVENT_<imei>_00000000_<yyyy_mm_dd_hh_mm_ss>_<channel F/I>_<code>.mp4` (code per event / camera).

## Automatic set-up (v1.27.1)
With **JIMI_SETUP_COMMANDS** in the API .env (`|`-separated, e.g. `UPLOAD,http://track.veetrax.com/dvr/upload|RSERVICE,103.176.85.69:1935/live`), `commands/dvr-auto-setup.service.ts` sends each command once a minute to every connected Jimi camera (model protocol GT06 + capability `video`, linked to a vehicle) until the camera has acknowledged it (resend after 10 min unanswered). The commands show in the vehicle history (no user). Only `COREKITSW,0` and `SERVER,0,<ip>,5023` still go by SMS. Empty = off (demo: no MediaMTX).

## Clip upload (v1.25.0)
`dvr-upload/`: public `POST /api/dvr/jimi/upload` (Caddy also maps `http://track.veetrax.com/dvr/upload`).
- Multipart `file`; `filename`, `timestamp`, `sign` as form fields or URL parameters.
- sign = Base64(md5 hex(filename + timestamp + key)); the firmware key is in the API .env as **JIMI_UPLOAD_KEY**
  (value from the vendor document; not in the repository).
- The IMEI in the file name finds the device; capture time and place come from the 0x95 alarm position whose
  `mediaFiles` lists the file (else the name's time in the company time zone).
- The file then follows the JT/T 808 attachment path: var/driver-media/incoming → `vt:driver-media` → the notifier's
  DriverEventWorker links it to the driver event → "Watch video".
- Replies `{code:200}` even for unknown devices, so the camera does not retry forever.

## Live video (v1.25.0)
- MediaMTX (MIT; `ops/deploy/linux/install-mediamtx.sh`, unit veetrax-mediamtx) takes RTMP on :1935 (paths
  `live/<n>/<imei>` for live, `live/<imei>` for SD-card playback) and serves HLS on 127.0.0.1:8888; its API is on 127.0.0.1:9997.
- `VideoService`: protocol GT06 + capability `video` = RTMP camera. Live sends `RTMP,ON,OUT|IN,15`
  (CommandsService.sendInternal, shown in the command history), waits up to 25 s for the stream and returns
  `/api/video/hls/<session>/<token>/index.m3u8` (token valid while the camera streams).
- Channel 1 = road camera (OUT), 2 = driver camera (IN). The web player uses hls.js (Apache-2.0) for .m3u8 URLs.

## SD-card recordings (v1.29.0)
- `FILELIST,<url>` sets where the camera posts its name list; `FILELIST` alone makes it post now. Body JSON
  `{"imei":"…","fileNameList":"a.mp4,b.mp4"}`, answer `{"code":0,"ok":true}`. Our URL: `http://track.veetrax.com/dvr/filelist`.
- Names `yyyy_mm_dd_hh_mi_ss_<code>.mp4` in camera local time: 01 road / 02 driver (1-min, low quality), 03 / 04 HD.
- `REPLAYLIST,<name>,<name>…` pushes the files over RTMP to `live/<imei>` (no channel); `REPLAYLIST,OFF` stops.
- `HVIDEO,<yyyy_mm_dd_hh_mi_ss>,<1|2>` uploads one recorded minute through the HTTP upload (for downloads, not built yet).

## Still to build
- Downloads of recorded video (HVIDEO queue) and the timeline page.
- Device test: no unit yet; layouts are checked against the vendor's example packets only.
