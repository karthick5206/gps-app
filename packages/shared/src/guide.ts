/**
 * Getting-started guide for customers (personal and business accounts): shown at /guide in the web app (public, so
 * the mobile apps and emails can link to it) and rendered as the PDF attached to the welcome email.
 * Facts follow docs/devices/DEVICE_SETUP.md (installer guide); keep both in step.
 */

/** Device server for trackers and dashcams (TCP, DNS-only). */
export const DEVICE_SERVER_HOST = 'track.mintplus.co.in';
export const DEVICE_SERVER_PORTS = { GT06: 5023, TELTONIKA: 5027, JT808: 6808, AIS140: 5030, VIDEO: 7612 } as const;

export interface GuideStep {
  text: string;
  /** Exact text to type or send (SMS command, server name …), shown in a monospace box. */
  code?: string;
}

export interface GuideSection {
  id: string;
  title: string;
  intro?: string;
  steps: GuideStep[];
  notes?: string[];
}

const H = DEVICE_SERVER_HOST;
const P = DEVICE_SERVER_PORTS;

export const GUIDE_TITLE = 'VeeTrax — Getting started';

export const GUIDE_SECTIONS: readonly GuideSection[] = [
  {
    id: 'licences',
    title: '1. Licences first',
    intro: 'Every tracker, dashcam and phone needs a yearly licence. Prices include GST.',
    steps: [
      { text: 'Sign in at app.veetrax.com and open Billing & Licences.' },
      { text: 'Choose how many GPS device, Dashcam and Mobile tracker licences you need and see the price.' },
      { text: 'Choose how to pay: UPI (scan the QR with the exact amount, then enter the UTR) or Cash (say you have paid, or where and when to collect it). Bank transfer details are shown too.' },
      { text: 'We activate the licences once the payment is received and email you the GST invoice.' },
    ],
  },
  {
    id: 'phone',
    title: '2. Track a phone (VeeTrax Tracker app)',
    intro: 'Turn an Android phone into a tracker: your own phone, a family member’s, or a staff phone.',
    steps: [
      { text: 'In VeeTrax: Dashboard → Get started → Track a phone (or Devices → Add, model "VeeTrax · Mobile tracker (Android)"). Enter the phone’s mobile number and a name such as "Me" or "Amma".' },
      { text: 'On that phone, install the VeeTrax Tracker app (ask VeeTrax support for the link).' },
      { text: 'Open the app, enter the same mobile number and tap Send code. Enter the 6-digit code. If no SMS arrives, open the device in VeeTrax → Devices → Edit: the code is shown there.' },
      { text: 'Tap Start. Allow location "All the time" and "Precise", allow notifications, and allow "Don’t optimise battery" when the app asks.' },
      { text: 'Within a minute the phone appears on the Live Map.' },
    ],
    notes: [
      'Changing phones: install the app on the new phone and activate it with the same number. The old phone stops by itself; history continues.',
      'Xiaomi, Oppo, Vivo, Realme and some Samsung phones stop background apps: also turn on "Autostart" and set battery to "No restrictions" for VeeTrax Tracker.',
      'Press and hold the red SOS button in the app for 2 seconds to send an SOS alarm with your location.',
    ],
  },
  {
    id: 'shipped',
    title: '3. Add a GPS tracker we sent you',
    steps: [
      { text: 'Fit the tracker (wiring is on the help sheet in the box) and make sure the SIM inside has a data plan.' },
      { text: 'Scan the QR code on the help sheet, or open VeeTrax → Get started → Add a tracker.' },
      { text: 'Enter the IMEI and claim code from the help sheet, give it a name (e.g. "My car") and choose what it tracks (vehicle, person, asset or pet).' },
      { text: 'Sign in with the email or mobile number the tracker was sent to. It appears on the Live Map once it connects.' },
    ],
  },
  {
    id: 'byod',
    title: '4. Add a GPS tracker bought elsewhere',
    intro: 'Point the tracker at the VeeTrax server, then add it by IMEI.',
    steps: [
      { text: 'Wire it: red = +12/24 V permanent, black = ground, ignition wire (orange/yellow on Concox, white/DIN1 on Teltonika) = ignition (ACC).' },
      { text: 'Insert a SIM with data. Common APNs: Airtel airtelgprs.com, Jio jionet, Vi www, BSNL bsnlnet.' },
      { text: 'Concox / Jimi (GT06N, GT800, V5, VL149, AT4…): send these SMS to the tracker’s SIM:', code: `SERVER,1,${H},${P.GT06},0#\nAPN,airtelgprs.com#\nTIMER,10,180#` },
      { text: 'Teltonika (FMB920, FMB120, FMC130…): in Configurator → GPRS set domain, port and TCP, or send this SMS (it starts with two spaces):', code: `  setparam 2001:airtelgprs.com;2004:${H};2005:${P.TELTONIKA};2006:0` },
      { text: 'Power it on and wait 2–5 minutes, then VeeTrax → Get started → Add a tracker: enter the IMEI (15 digits, on the label), choose the model, name it.' },
    ],
    notes: [
      'If it says "We have not heard from this tracker yet", check the SIM data, the server SMS reply and that the tracker is powered, then try again.',
      'Older Concox firmware needs the password after the command name, e.g. SERVER,666666,1,…#.',
    ],
  },
  {
    id: 'dashcam',
    title: '5. Add a dashcam (JT/T 808, e.g. Mettax MC202)',
    steps: [
      { text: 'In the dashcam’s menu or the vendor’s tool, set the platform server:', code: `Server: ${H}\nPort: ${P.JT808} (TCP)\nProtocol: JT/T 808` },
      { text: 'Set the video codec to H.264 and keep a memory card inserted for recordings.' },
      { text: 'Note the dashcam’s "terminal phone / device ID". It is the dashcam’s identity in VeeTrax (not the IMEI). Leave out leading zeros: 013912345678 becomes 13912345678.' },
      { text: 'Power it on, wait a few minutes, then VeeTrax → Add a tracker: enter the terminal ID, choose the dashcam model, name the vehicle.' },
      { text: 'Watch live and recorded video in Live Map → vehicle → Video, or on the Video page. Driver-behaviour (ADAS / DMS) events with snapshots are under Driver events.' },
    ],
    notes: [`Video streams over a second connection to ${H}:${P.VIDEO}. About 115–230 MB of SIM data per hour per camera while you watch.`],
  },
  {
    id: 'assign',
    title: '6. Vehicles, people and assignment',
    steps: [
      { text: 'Vehicles & Objects lists everything you track. Open one to set the name, plate number, vehicle type, colour and overspeed limit.' },
      { text: 'To move a tracker to another vehicle: edit the vehicle and choose the device. The old vehicle keeps its history.' },
      { text: 'Documents & Service: add insurance, PUC, permit and service dates to get reminders before they expire.' },
    ],
  },
  {
    id: 'alerts',
    title: '7. Alerts and notifications',
    steps: [
      { text: 'Alert Settings: switch alerts on or off (ignition, overspeed, geofence, SOS, power cut, low battery, AC / door…) and choose how you are told: in the app, push to the phone, email or SMS.' },
      { text: 'Geofences: draw areas (home, office, school) to get enter / exit alerts.' },
      { text: 'SOS, crash, power cut and tamper alerts ring a loud siren on the phone app until someone acknowledges them.' },
    ],
  },
  {
    id: 'apps',
    title: '8. Mobile app, history and reports',
    steps: [
      { text: 'Install the VeeTrax app (Android) and sign in with the same email and password to see the live map, alerts with push notifications, history playback and reports.' },
      { text: 'History & Playback: replay any day, coloured by status or speed, with stops and addresses.' },
      { text: 'Reports: trips, stops, distance, overspeed, AC / door and more; download as Excel, PDF or CSV.' },
    ],
  },
];
