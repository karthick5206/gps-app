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
    title: '1. Free trial, then a licence',
    intro: 'Start free: a new personal account tries each phone for 100 days (first 5 phones) and each GPS tracker or dashcam for 30 days (first 5). After the trial, every tracker, dashcam and phone needs a yearly licence. Prices include GST.',
    steps: [
      { text: 'Nothing to buy to start: add your phone or tracker (sections 2–4) and it is tracked straight away on the free trial.' },
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
  {
    id: 'ask',
    title: '9. Ask VeeTrax (smart search)',
    intro: 'Type or speak a short question about your vehicles and get the answer at once, with buttons to open the map, History or a report. Open it with the ✨ Ask button at the top of the web app (or Ctrl + K), or from the map / More in the mobile app.',
    steps: [
      { text: 'Name the vehicle by its number or name, with or without spaces: "TN 09 BB 9421", "tn09bb9421", the last digits "9421", or a person\x27s name.' },
      { text: 'Say when: now, today, yesterday, at 3 pm, 30 Oct, this week, last week, this month, last 5 days, last night. Without a time, today is used.' },
      { text: 'Say what you want: where / location, km / distance, trips, idle, overspeed, alerts, offline, battery, charging, documents / service due, moved at night.' },
      { text: 'Examples: "Where is TN 09 BB 9421", "Where was 9421 yesterday at 3 pm", "Km 9421 this week", "Most idle this week", "Overspeed today", "Offline vehicles", "Trips 9421 yesterday", "Documents due", "Moved last night".' },
      { text: 'Tamil and Hindi words work too, for example "9421 எங்கே", "நேற்று கிமீ 9421", "आज ओवरस्पीड". Tap the microphone to speak instead of typing (Chrome or Edge on a computer; any Android phone).' },
      { text: 'Staff attendance in one word: type "attendance" to see today at a glance — present, late, half day, absent, and who is inside, out or without signal right now. Add what you want: "Who is absent today", "Late this week", "Who is out now", "Overtime this month", or a name: "Priya attendance this month". The buttons under each answer open Staff attendance, that person\'s Employee view or the Payroll report.' },
      { text: 'Fuel & expenses and driver scores: "Expenses this month", "Fuel cost TN 09 BB 9421 last month", "Worst drivers this week", "Best driver this month".' },
    ],
    notes: ['Answers only cover the vehicles you are allowed to see. If a question is not understood, VeeTrax shows example questions; if several vehicles match, it asks which one.'],
  },
  {
    id: 'attendance-setup',
    title: '10. Staff attendance: setting it up',
    intro:
      'Staff attendance marks staff in and out automatically when their phone (VeeTrax Tracker app) or ID card reaches or leaves a work site. Nobody punches a card: the location does it. Only company admins see this; staff see their own day in the Tracker app.',
    steps: [
      { text: 'Draw each work site (office, store, branch, warehouse) as a geofence: Geofences → Add. Give each one its branch. A site can be any shape; draw it a little larger than the building so GPS drift near the walls does not count as leaving.' },
      { text: 'Make sure every staff member is tracked: a phone with the VeeTrax Tracker app, or an ID card. Put their employee number in "Plate number / Staff ID" on the person (Masters → Vehicles & Objects → Edit) — it is shown as Staff ID in every report and is how payroll software matches people.' },
      { text: 'Open Staff attendance → Settings and switch Attendance on. Choose the work-site geofences. Leave "Staff" empty to include everyone tracked by phone or ID card, or pick particular people.' },
      { text: 'Set the default shift: working days (e.g. Monday–Saturday) and hours (e.g. 09:30–18:30). Arriving within the grace period after the start (e.g. 15 min) is still on time.' },
      { text: 'Different hours for some branches or people? Add a Shift (e.g. "Store 10–20", "Night shift") and choose its branches and/or people. A person on a shift follows it whatever their branch; everyone else is on the default shift.' },
      { text: 'Optional — Selfie at check-in: staff are asked in the Tracker app for a selfie, a 10-second video, or both, when they reach their site. The photo is stamped with name, time, address and coordinates. A missing selfie is flagged; it never changes the day\'s status.' },
      { text: 'Save. From now on each day fills in by itself; the Day view shows everyone for today, refreshed every minute.' },
    ],
    notes: [
      'Staff phones need location "All the time" and battery "No restrictions", or the phone may stop reporting and the day shows "No signal".',
      'Changing settings changes how today and later days are worked out. Finished days keep the rules they were worked out with, so last month\'s figures do not move.',
    ],
  },
  {
    id: 'attendance-rules',
    title: '11. Staff attendance: how each day is worked out',
    intro: 'Every rule below is in Staff attendance → Settings → Rules, and each company chooses its own. Example shift used here: 09:30–18:30, grace 15 min.',
    steps: [
      { text: 'Status. Present = arrived by 09:45 (start + grace). Late = arrived after 09:45 (Late shows the minutes after the grace). Not arrived = the grace is over and nobody has come yet (today). Absent = never came, or worked less than the half-day hours. Half day = worked at least the half-day hours (e.g. 4 h) but less than the full-day hours (e.g. 8 h). Day off = not a working day of their shift.' },
      { text: 'Worked time = time inside a work site + official-duty time outside. First in is when they first arrived; Last out is when they finally left (address, coordinates and a map link are shown for both).' },
      { text: 'Right now (today only): Inside = at a work site now; Out now = away from the site during the shift; No signal = no recent location from their phone or card. Click a tile on the Day view to see only those people.' },
      { text: 'Time away from the work site. When someone leaves during the shift for longer than the "Short exit" (e.g. 5 min), it is listed with the time they left and came back. The Tracker app asks them "Was it for work?" — Official duty counts as worked; Personal work does not. Until anyone answers it is "Not explained yet" (not worked). An admin can mark it Official duty or Personal work at any time; the admin\'s decision wins over the employee\'s answer.' },
      { text: 'Count work sites of every branch (on by default). On: being at ANY of your work sites counts — a day at another branch or a meeting at head office is a normal working day. Off: staff count only at their own branch\'s sites (and sites without a branch); you can still list people allowed at every branch.' },
      { text: 'Travel between work sites is official duty (on by default, up to 120 min). Going straight from one work site to a DIFFERENT one within this time counts as worked, shown as "Travel between work sites, counted automatically", and staff are not asked. Example: left the office 12:00, reached the Guindy branch 12:40 → 40 min official duty.' },
      { text: 'Break allowance (on by default, 45 min a day). Short trips out that come back — lunch, tea — up to this total a day are not questioned and count as worked. Example: lunch 13:00–13:30 is covered; a second 30-minute trip at 16:00 would make 60 min, so it is asked about. A trip the employee already answered is never treated as a break.' },
      { text: 'Count overtime (on by default, from 15 min). Overtime is only time worked AFTER the shift end, and only what is beyond a full shift in total — so coming late and staying late to make up is not overtime. Less than the minimum (e.g. 15 min) after the end is not counted. Examples: 09:30–20:00 → 1 h 30 min; came 11:30 (2 h late), left 20:30 → 0; left 18:40 → 0 (under 15 min). Switch it off if your company does not pay overtime.' },
      { text: 'Early leave = left for the day before the shift end (unless the last trip out was official duty). No signal = the phone sent nothing for longer than the "No signal after" time; that time is not counted as worked, because nobody knows where the phone was.' },
      { text: 'Per-shift values: a shift can have its own Break allowance and Travel time (e.g. 60 min break for the store, none for the office). Leave them empty to use the company setting.' },
      { text: 'Correct a day by hand: open the person\'s day → Correct this day → Present, Half day, Absent or Day off, with a reason. The figures stay; the status changes and the day shows "Corrected". A day corrected to Absent or Day off shows no late, early leave or overtime; a half day earns no overtime.' },
    ],
    notes: [
      'Days are re-checked every hour for three days, so a phone that uploads late (no internet) is still counted. After that a finished day is fixed.',
      'Alerts: "Staff not arrived" after start + grace, "Staff absent" at the end of the shift, "Staff left work site" when someone is out longer than a short exit, "Staff still out" after the reminder time. Choose who gets them in Alert Settings.',
    ],
  },
  {
    id: 'attendance-payroll',
    title: '12. Staff attendance: reports, payroll and the Developer API',
    steps: [
      { text: 'Reports → Staff attendance has five reports, each as Excel, PDF or CSV and each can be e-mailed on a schedule: Daily attendance (one line per person per day), Attendance summary (per person for the period, with attendance %), Payroll, Time outside (every trip out and who decided it) and Corrections (every hand correction with its reason).' },
      { text: 'Payroll report — made for salary processing, one line per person: Working days (days due), Present days (on time or late), Half days, Absent days, Weekly offs, Payable days = present + half of the half days + weekly offs, LOP days (loss of pay) = absent + half of the half days, Late days and minutes, Early-leave days and minutes, Worked hours, Overtime hours, Official-duty hours and Unexplained hours (decimal hours, e.g. 7.75), and Corrected days.' },
      { text: 'Run it for your pay period (e.g. 1st–30th), check the Corrections, then give the Excel to your accountant or import the CSV into your payroll software. Staff are matched by Staff ID.' },
      { text: 'Connect payroll software directly (Developer API): Administration → Developer API → Create API key, tick "Staff attendance" (read:attendance). Give the key to your payroll vendor. The key can only read attendance and payroll figures; it cannot change anything.' },
      { text: 'The payroll software then asks for the period: GET https://app.veetrax.com/api/v1/attendance/payroll?from=2026-11-01&to=2026-11-30 with the header "Authorization: Bearer <your key>". Add &format=csv for a spreadsheet file, &branchId=… for one branch, or &staffIds=… for particular people. GET /api/v1/attendance/daily gives the day-by-day lines. Up to 62 days per request; full field list at https://app.veetrax.com/api/v1/openapi.json.' },
    ],
    notes: [
      'Holidays and approved leave are not entered in VeeTrax yet: correct such days to "Day off" (paid) before running payroll, or handle them in your payroll software.',
      'Revoke an API key at any time in Administration → Developer API; requests with it stop at once.',
    ],
  },
];
