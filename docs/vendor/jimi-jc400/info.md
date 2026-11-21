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
2. `UPLOAD,http://<host>/upload`, clip / photo upload server (phase 2, not built yet).
3. `RSERVICE,<host>:1935/live`, RTMP live video server (phase 3, not built yet).
4. `SERVER,0,103.176.85.69,5023` (live) or `SERVER,1,track.mintplus.co.in,5023` (demo): TCP server, then the device restarts.

Useful commands: `VERSION`, `STATUS`, `PARAM`, `REBOOT`, `Picture,in|out|inout`, `Video,in|out|inout,3s..10s`,
`RTMP,ON|OFF,IN|OUT|INOUT,<minutes>`, `UPLOADFILE,<clip name>`, `UPLOADSW,<event>,ON|OFF|1|2`, `RELAY,<0|1>`.
Clip names: `EVENT_<imei>_00000000_<yyyy_mm_dd_hh_mm_ss>_<channel F/I>_<code>.mp4` (code per event / camera).

## Still to build
- **Phase 2:** HTTP upload server (`POST /upload`, multipart, `sign` = Base64(md5(filename + timestamp + key)))
  and linking `mediaFiles` from 0x95 to the uploaded clips; playback name list endpoint (`FILELIST`).
- **Phase 3:** RTMP ingest (open-source server, e.g. MediaMTX, MIT) and the live / playback player (`RTMP,ON,…`,
  `REPLAYLIST,<names>`).
- Device test: no unit available yet (2026-11-21); all layouts are checked against the vendor's example packets only.
