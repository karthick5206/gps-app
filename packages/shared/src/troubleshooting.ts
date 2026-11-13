/**
 * Device troubleshooting guide for Concox / Jimi trackers (GT06N, GT800, V5, VL149, Wetrack2, Wetrack Lite): shown at
 * /guide/troubleshooting in the web app (public, so support can send the link). Same section shape as the
 * getting-started guide (guide.ts). Commands are SMS commands sent to the tracker's SIM; the server lines use the
 * VeeTrax device server, never a supplier's.
 */

import { DEVICE_SERVER_HOST, DEVICE_SERVER_PORTS, type GuideSection } from './guide';

const H = DEVICE_SERVER_HOST;
const P = DEVICE_SERVER_PORTS.GT06;

export const TROUBLESHOOTING_TITLE = 'Tracker troubleshooting';
export const TROUBLESHOOTING_INTRO =
  'Checks and SMS commands for Concox / Jimi trackers (GT06N, GT800, V5, VL149, Wetrack2, Wetrack Lite). Send each command as an SMS to the SIM inside the tracker; it answers by SMS. Commands are not case-sensitive. After changing settings, watch the vehicle for a day or two before changing anything else.';

export const TROUBLESHOOTING_SECTIONS: readonly GuideSection[] = [
  {
    id: 'basic',
    title: '1. First checks',
    intro: 'Start here when a tracker is offline, shows no location or shows the wrong place.',
    steps: [
      { text: 'Send this to check the tracker answers SMS at all. It replies with its IMEI and main settings.', code: 'PARAM#' },
      { text: 'No reply: check that the SIM is inserted, active and has SMS and data balance, and that the tracker has power (look at the wiring and the LEDs).' },
      { text: 'Reply received but the vehicle is offline in VeeTrax: send these three and read the replies.', code: 'STATUS#\nCHECK#\nAPN#' },
      { text: 'In the STATUS# reply, "GPRS: Link Up" means the tracker is connected to a server; "Link Down" means it is not. Usual causes: wrong APN, wrong server address or port, no mobile data, or the SIM provider blocking the connection (see section 3).' },
      { text: 'In the CHECK# reply, GPRS 1 means mobile data works, 0 means it does not. If the server is set by name, "GET IP 0.0.0.0" also means there is no data connection.' },
      { text: 'Set the APN of the SIM if it is wrong (examples: Airtel airtelgprs.com, Airtel IoT airteliot.com, Jio jionet, Vi www, BSNL bsnlnet).', code: 'APN,airtelgprs.com#' },
      { text: 'Make sure the tracker points to the VeeTrax server, then restart it and check STATUS# again after 2 minutes.', code: `SERVER,1,${H},${P},0#\nRESET#` },
      { text: 'Link Up but still offline in VeeTrax: check that the IMEI in the PARAM# reply matches the IMEI of the device in VeeTrax (Masters → Devices).' },
    ],
    notes: ['When you contact VeeTrax support, send the IMEI and the full replies of PARAM#, STATUS# and CHECK#.'],
  },
  {
    id: 'satellite',
    title: '2. "Searching satellite" or no GPS fix',
    steps: [
      { text: 'Send WHERE# to see the last position the tracker fixed, with its date and time.', code: 'WHERE#' },
      { text: 'In STATUS#, satellites shown as 0(24) or 0(4) mean no fix: the tracker sees the sky badly. Drive the vehicle into the open and send STATUS# again while moving.' },
      { text: 'Still 0 while moving in the open: move the tracker. It must face the sky, away from metal sheets, metallic window film and the engine; under the dashboard near the windscreen usually works.' },
      { text: 'New gadgets in the vehicle (Bluetooth speakers, chargers, dashcams, LED bars) can jam GPS. Remove them one by one, or take the tracker outside the vehicle to test.' },
      { text: '"Uart no data" in STATUS# even while moving in the open means the GPS module has failed. The tracker needs repair or replacement: contact VeeTrax support.' },
      { text: 'Wrong place in VeeTrax: first make sure GPS is fixed and the link is up (STATUS#), then compare with the tracker’s own position. URL# replies with a map link, WHERE# with latitude, longitude and speed.', code: 'STATUS#\nURL#\nWHERE#' },
    ],
    notes: ['A free phone app such as "GPS Test" shows how well satellites are received at the spot where the tracker is fitted.'],
  },
  {
    id: 'sim-data',
    title: '3. M2M / IoT SIM: allow the VeeTrax server',
    intro: 'Many M2M and IoT SIMs (Airtel IoT, Vi IoT, Jio IoT, BSNL M2M) only reach addresses that are allowed (whitelisted) on the SIM provider’s portal.',
    steps: [
      { text: `Ask the SIM provider, or allow it yourself on their M2M portal, for the VeeTrax device server: ${H}, TCP port ${P}. Allow both the name and its IP address; some networks cannot look up names.` },
      { text: 'Allow the TCP protocol (and HTTP / UDP if the portal lists protocols) for the APN of these SIMs.' },
      { text: 'Typical sign of a blocked connection: the tracker logs in and the connection drops within a second, again and again, so no positions arrive although STATUS# sometimes shows Link Up. Raise a complaint with the SIM provider: "data connection disconnects within milliseconds".' },
      { text: 'Meanwhile URL# or WHERE# still shows where the vehicle is.', code: 'WHERE#' },
    ],
  },
  {
    id: 'sleep',
    title: '4. Sleep mode (save vehicle battery and data)',
    intro: 'In sleep mode the GPS part switches off some minutes after the ignition goes off; the mobile part stays on and sends a short "heartbeat" so VeeTrax knows the tracker is alive. Positions start again as soon as the ignition is on.',
    steps: [
      { text: 'SENDS sets the minutes after ignition off before GPS sleeps (0 = never sleep).', code: 'SENDS,5#' },
      {
        text: 'Turn sleep mode on (recommended for most vehicles). TIMER is the position interval in seconds: ignition on, then ignition off.',
        code: 'GPSDUP,OFF#\nSENDS,5#\nHBT,1,1#\nTIMER,10,3600#\nSF,ON#\nFDRIFT,ON#',
      },
      {
        text: 'Turn sleep mode off (GPS always on, a position every 10 seconds whether the ignition is on or off; a parked vehicle may then show small jumps).',
        code: 'SENDS,0#\nGPSDUP,ON#\nHBT,1,1#\nTIMER,10,10#\nSF,ON#\nFDRIFT,OFF#',
      },
    ],
  },
  {
    id: 'alerts',
    title: '5. Alerts on the tracker',
    intro: 'Most alerts (overspeed, ignition, geofence, power cut) are set in VeeTrax under Alerts and need nothing on the tracker. Use these only when you want the tracker itself to detect the event. In each command, M is how it reports: 0 = to the server only, 1 = server and SMS. Send the name with # alone (for example SPEED#) to see the current setting.',
    steps: [
      { text: 'Overspeed: on/off, seconds above the limit, speed limit in km/h, report way.', code: 'SPEED,ON,10,60,0#' },
      { text: 'Harsh acceleration and braking: on/off, report way, detection seconds, speed gain and speed drop in km/h.', code: 'SPEEDCHECK,ON,0,4,15,15#' },
      { text: 'Sharp turn: on/off, report way, angle in degrees, minimum speed in km/h, detection seconds.', code: 'SWERVE,ON,0,15,15,3#' },
      { text: 'Moving while parked (towing or theft): on/off, radius in metres (100–1000), report way.', code: 'MOVING,ON,100,2#' },
      { text: 'Power cut (tracker disconnected from the vehicle battery): on/off, report way (2 adds a phone call), seconds before alarm, seconds between repeats.', code: 'POWERALM,ON,0,10,60#' },
      { text: 'Tracker’s own battery low: on/off, report way.', code: 'BATALM,ON,0#' },
      { text: 'Ignition on/off alarm: on/off, report way.', code: 'ACCALM,ON,0#' },
      { text: 'Collision (V5, VL149): on/off, report way, sensitivity (10–1024), delay and detection seconds, minimum speed.', code: 'COLLIDE,ON,0,480,10,90,5#' },
      { text: 'Heartbeat interval in minutes: ignition on, ignition off (1–300).', code: 'HBT,1,1#' },
      { text: 'Extra point on every turn (smoother route on the map): on/off, angle in degrees, detection seconds.', code: 'ANGLEREP,ON,30,3#' },
      { text: 'Odometer on the tracker: on/off, start value in km (0 resets it).', code: 'MILEAGE,ON#' },
    ],
  },
  {
    id: 'power',
    title: '6. Vehicle battery, ignition and relay (V5, VL149, GT800, Wetrack2)',
    steps: [
      { text: 'Report the vehicle battery voltage to VeeTrax: on/off, every N seconds (5–3600).', code: 'ADT,ON,30#' },
      { text: 'Ignition by wire (0) or detected from vibration / voltage ("soft ignition", 3) on V5 and VL149. Use 0 when the ignition wire is connected. Wetrack2 uses VACC,ON# / VACC,OFF#.', code: 'ACC,ON,0#' },
      { text: 'Position interval in seconds: ignition on, ignition off (5–18000).', code: 'TIMER,10,10#' },
      {
        text: 'Protect the vehicle battery: stop the tracker when the battery falls below N1 and restart above N2 (values in 0.1 V, e.g. 120 = 12.0 V). Alarm only: EXBATALM with the same values. FLYCUT,ON# is needed once to make the cut-off work.',
        code: 'EXBATCUT,ON,1,120,135,10#\nEXBATALM,ON,0,100,130,10#\nFLYCUT,ON#',
      },
      { text: 'Relay (engine immobiliser), when a relay is fitted. Use only when the vehicle is stopped and it is safe; 1 cuts, 0 restores. From VeeTrax use Commands on the vehicle instead.', code: 'RELAY,1#\nRELAY,0#' },
    ],
    notes: [
      'Power use of a V5 / VL149: about 6 mA when parked (heartbeat only) and about 70 mA while moving. Data use is about 100–120 MB a month.',
      'The tracker stores up to 1000 positions while it has no network and sends them when the network returns.',
    ],
  },
  {
    id: 'sos-password',
    title: '7. SOS numbers, centre number and password',
    steps: [
      { text: 'Up to 3 SOS numbers (called when the SOS button is pressed). Add with A, delete with D.', code: 'SOS,A,9876543210,9876543211#\nSOS,D,9876543211#' },
      { text: 'One centre number (the owner’s phone, allowed to send all commands).', code: 'CENTER,A,9876543210#\nCENTER,D,9876543210#' },
      { text: 'Change the default password 666666 to your own 6 digits, then switch password protection on. Set the SOS and centre numbers first.', code: 'PASSWORD,666666,123456#\nPWDSW,ON#' },
      { text: 'With the password on, put it after the command name.', code: `PARAM,123456#\nSERVER,123456,1,${H},${P},0#` },
    ],
    notes: ['LOCKIP# fixes the server so it cannot be changed by SMS, and suppliers usually cannot unlock it remotely. Check SERVER# first and avoid LOCKIP unless the customer asks for it.'],
  },
  {
    id: 'filters',
    title: '8. Position filters: GPSDUP, SF, FDRIFT, SENSORSET',
    steps: [
      { text: 'GPSDUP: when the ignition is off or GPS is not fixed, ON keeps sending the last good position with a new time (vehicle stays "online"); OFF sends nothing until the next fix.', code: 'GPSDUP,ON#' },
      { text: 'SF (static filter): while parked, ignores jumps within this many metres (10–1000). VL149 and V5 4G take a third value: ignore any jump faster than this km/h.', code: 'SF,ON,100#\nSF,ON,100,180#' },
      { text: 'FDRIFT (speed filter): removes speed noise. Turn it OFF for very slow vehicles (e-rickshaws, 5–10 km/h in narrow lanes) that otherwise send too few points.', code: 'FDRIFT,OFF#' },
      { text: 'SENSORSET (motion sensor): detection seconds, vibrations that wake the GPS, vibrations before an alert, detection interval. Rule: first ≥ third × fourth ≥ second × fourth.', code: 'SENSORSET,10,1,1,1#' },
      { text: 'Clear the positions stored in the tracker (e.g. very old points arriving late). Always restart afterwards, or it stops sending. _SYS,A# shows how many are stored.', code: 'CLEAR#\nRESET#' },
    ],
  },
  {
    id: 'drift-parked',
    title: '9. Fix: position jumps while parked',
    intro: 'The vehicle is parked but the map shows it jumping around or small trips at night. Send these, then watch for 1–2 days.',
    steps: [{ text: 'Settings:', code: 'SENDS,5#\nSF,ON,100#\nGPSDUP,OFF#\nTIMER,10,180#\nHBT,1,1#\nFDRIFT,ON#\nACC,ON,0#\nSENALM,OFF#' }],
  },
  {
    id: 'drift-moving',
    title: '10. Fix: jumps or zig-zag while moving',
    intro: 'The route while driving shows spikes or zig-zags. Send these, then watch for 1–2 days.',
    steps: [{ text: 'Settings:', code: 'SENDS,5#\nSF,ON,100#\nGPSDUP,OFF#\nTIMER,10,180#\nHBT,1,1#\nFDRIFT,OFF#\nACC,ON,0#\nSENALM,OFF#\nANGLEREP,ON,5,2#' }],
  },
  {
    id: 'slow',
    title: '11. Fix: slow vehicles send too few points',
    intro: 'For e-rickshaws, tractors, carts or vehicles that move at 2–10 km/h and show straight lines or gaps. Send these, then watch for 1–2 days.',
    steps: [
      { text: 'Settings:', code: 'SF,OFF#\nFDRIFT,OFF#\nANGLEREP,ON,5,2#\nACC,ON,0#\nGPSDUP,OFF#\nHBT,1,1#\nTIMER,5,10#\nSPEED,ON,5,15,0#\nSENDS,5#\nPBSW,OFF#\nLEVEL,5#\nACCALM,ON,0#' },
    ],
    notes: ['Still not right after this? Contact VeeTrax support with the IMEI, the vehicle and the date and time of the problem.'],
  },
];
