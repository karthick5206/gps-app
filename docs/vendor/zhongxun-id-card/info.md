# ID card trackers: integration notes

Our own notes, written from two vendor documents the project owner keeps locally (C:\Users\sasva\OneDrive\Desktop\veetracer\ID card protocol); the PDFs are not stored in this repository.

## 1. Blue ID card: "Zhongxun Locator Communication Protocol" V1.1–V1.3 (e.g. IMEI 861261029306483)
- **Own port: ZHONGXUN_PORT 5032** (`gateway/zhongxun`), device model **Zhongxun · Blue ID card** (protocol ZHONGXUN).
- Card command to point it at us (the card's own SMS format): `SERVER#103.176.85.69#5032#` (IP only; a domain name is not accepted).
- Frames look like Concox (`78 78 … 0D 0A`) but have **no serial number and no checksum**; byte 2 is often not a length (0x17 / 0x18 / 0x69 = number of Wi-Fi hotspots, replies use 00), and `0D 0A` can occur inside a date. `splitZhongxun` therefore takes each packet's length from its documented layout.
- Handled: 0x01 login (reply `7878 01 01 0D0A`), 0x08 heartbeat, 0x10 / 0x11 GPS (live / stored; V1.2 adds altitude + alarm byte), 0x13 status (battery %, time zone, signal; echoed), 0x17 / 0x18 / 0x19 / 0x1A / 0x1B / 0x69 Wi-Fi + cell (answered with their date; no position: no cell location yet; alarm byte raises the alarm at the last fix), 0x30 time sync, 0x99 SOS, 0x86 overspeed, 0x94 vibration, 0x81 charge done / low battery (byte 2 = 02), 0x82 / 0x83 charger, 0x56 worn / removed (removed → tamper), 0xB3 ICCID, 0x98 / 0x67 echoed.
- Must-answer packets (else the card reconnects): 0x01, 0x10, 0x11, 0x13, 0x17, 0x69 (+ 4G variants).
- SOS (v1.30.1): the vendor document has no SOS bit in the V1.2 alarm byte; SOS is only the 0x99 packet (`7878 01 99 0D0A`, no GPS). A long press can also send the call-SOS request `7878 02 41 01 0D0A`, which we treat as SOS too. Both are answered with LOCATE (0x80) so a fresh fix follows the alarm.
- Commands (Commands tab): LOCATE (0x80), RESTART / SHUTDOWN (0x48), INTERVAL,<10–7200 s> (0x97), FIND,ON|OFF (0x49), SOSNUM,<number> (0x41), `#<hex>` raw.
- GPS time is UTC; coordinates as Concox (minutes × 30000).

## 2. 4G ID card: JT/T 808-2011 with vendor extras
- **Port 6808** (existing JT808 decoder), device model **Generic · 4G ID card (JT808)**.
- Extras handled: heartbeat body (battery % byte 0, work mode), 0x62 battery %, 0x64 temperature ×10 (**2 bytes**; dashcams' 47+ byte 0x64 is ADAS), 0x57 extended alarm word (bit 4 low battery, bit 7 low-power shutdown → `lowBattery`), 0x0120 ICCID, 0x0121 time request → 0x8121 (binary YY MM DD hh mm ss, UTC). SOS = alarm bit 0 as usual. 0x5D cells / 0x63 Wi-Fi are kept in raw extras (no cell location yet).

## Not done yet
- Location from Wi-Fi / cell data (needs a cell / Wi-Fi location service).
- Real-device captures: both decoders are checked against the documents' example packets only (2026-11-24).
