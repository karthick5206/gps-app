/** All user-facing text (English only for now). Keep new strings here so translation is easy later. */
export const S = {
  appName: 'VeeTrax Tracker',

  // Activation
  activateTitle: 'Activate this phone',
  activateIntro: 'Enter this phone\'s mobile number and your e-mail. We send a 6-digit code to the phone.',
  steps: ['Enter your mobile number and e-mail', 'Type the 6-digit code from the SMS', 'Tracking runs in the background until you stop it', 'See your location and history in the VeeTrax app'],
  mobileLabel: 'Mobile number',
  emailLabel: 'E-mail (required)',
  emailRequired: 'Enter your e-mail address.',
  emailHint: 'Individual / family: the phone is added to the VeeTrax account of this e-mail (a new one is created if needed). Company phones stay in the company account; the e-mail is kept as your contact.',
  emailPlaceholder: 'you@example.com',
  emailLabelRegistered: 'E-mail',
  emailRegisteredHint: 'This number is already registered. Keep the details or change them.',
  emailKeep: (masked: string) => `Registered with ${masked}. Leave empty to keep it, or type a new e-mail.`,
  emailInvalid: 'Enter a valid e-mail address.',
  nameLabel: 'Your name (optional)',
  namePlaceholder: 'e.g. Ravi',
  mobilePlaceholder: '98765 43210',
  mobileInvalid: 'Enter a 10-digit mobile number.',
  sendCode: 'Send code',
  codeLabel: '6-digit code',
  codeSentSms: (mobile: string) => `We sent a code by SMS to +${mobile}. It is valid for 10 minutes.`,
  codeSentEmail: (to: string[]) => `We e-mailed the code to ${to.join(", ")}. Ask them for it; it is valid for 10 minutes.`,
  codeNoSms: (mobile: string) =>
    `SMS is not available. Ask your administrator to read the code from the Devices page in VeeTrax (number +${mobile}).`,
  codeHelp: "If the SMS doesn't arrive, your administrator can read the code from the Devices page in VeeTrax.",
  codeInvalid: 'Enter the 6-digit code.',
  verify: 'Activate',
  changeNumber: 'Change number',
  resendCode: 'Send the code again',
  networkError: 'Could not reach the server. Check your internet connection and try again.',

  // Sign-out reasons
  reasonRevoked: 'Tracking moved to another phone with the same number.',
  reasonInvalid: 'Please activate again.',
  reasonInactive: 'Tracking switched off by your administrator.',
  reasonSignedOut: 'This phone was deactivated.',

  // Account details and the VeeTrax app
  mobile: 'Mobile',
  email: 'E-mail',
  accountType: 'Account',
  accountTypes: { BUSINESS: 'Company', INDIVIDUAL: 'Individual', FAMILY: 'Family' } as Record<string, string>,
  freeTrialUntil: 'Free tracking until',
  licenceUntil: 'Licence until',
  trialEnded: 'Free trial ended: buy a licence in the VeeTrax app to see this phone\'s location.',
  viewInAppTitle: 'See your tracking in the VeeTrax app',
  viewInAppBody: (email: string | null, mobile: string) =>
    `Sign in to the VeeTrax app or app.veetrax.com with ${email ? `${email} or ` : ''}an OTP on ${mobile} to see this phone's location, history and alerts.`,
  openVeetrax: 'Open VeeTrax',
  privacyPolicy: 'Privacy policy',
  deleteAccount: 'Delete account and data',

  // Home
  trackingOn: 'Tracking is ON',
  trackingOff: 'Tracking is OFF',
  startTracking: 'Start tracking',
  stopTracking: 'Stop tracking',
  signOutUnsent: (n: number) => `${n} locations are not uploaded yet and will be lost if they can't be sent now. Connect to the internet first if you can.`,
  attendanceTitle: 'Attendance',
  shiftToday: (from: string, to: string) => `Your shift today: ${from} to ${to}`,
  notCheckedIn: 'Not checked in yet. You check in automatically when you are at your work site during your shift.',
  stateInside: 'You are inside the work site.',
  stateOut: 'You are outside the work site.',
  stateNoSignal: 'No recent location from this phone. Keep tracking on.',
  checkedInAt: (time: string, site: string | null) => `Checked in at ${time}${site ? ` · ${site}` : ''}`,
  outingQuestion: (from: string, to: string | null, site: string | null) => `You left ${site ?? 'the work site'} at ${from}${to ? ` and came back at ${to}` : ''}. Was it for work?`,
  outingOfficial: 'Official duty',
  outingPersonal: 'Personal',
  outingNote: 'Add a note (optional)',
  selfieTitle: 'Check-in selfie',
  selfieBody: 'Your employer asks for a selfie when you check in. It is used only for attendance.',
  selfieButton: 'Take selfie',
  selfieDone: (time: string) => `Selfie taken at ${time}`,
  cameraDenied: 'Allow the camera for VeeTrax Tracker in your phone settings to take the selfie.',
  requiredTitle: 'Tracking is required',
  requiredBody: 'Your company requires location tracking on this phone, so it can\'t be switched off here. Please ask your administrator.',
  stopConfirmTitle: 'Stop tracking?',
  stopConfirmBody: 'Your location will no longer be shared with your VeeTrax account.',
  lastFix: 'Last location',
  accuracy: 'Accuracy',
  speed: 'Speed',
  waiting: 'Waiting to upload',
  lastUpload: 'Last upload',
  uploadError: 'Upload problem',
  never: 'Never',
  points: (n: number) => `${n} point${n === 1 ? '' : 's'}`,
  trackingFor: 'Tracking for',
  company: 'Company',
  uploadNow: 'Upload now',
  mode: 'GPS mode',
  modeMoving: 'Moving (high accuracy)',
  modeStationary: 'Stopped (battery saver)',
  filtered: 'Flagged (still sent)',
  filteredValue: (dropped: number, mock: number) => `${dropped} inaccurate / jumps${mock ? `, ${mock} fake GPS` : ''}`,
  notRunningTitle: 'Tracking stopped unexpectedly',
  notRunningBody: 'Android or the phone maker stopped the tracking service. Tap Start tracking again, then check the battery and autostart settings below.',

  // SOS
  sos: 'SOS',
  sosHint: 'Press and hold for 2 seconds',
  sosSending: 'Sending SOS…',
  sosSent: 'SOS sent to your VeeTrax account.',
  sosQueued: 'No connection. SOS saved and will be sent as soon as possible.',
  sosNoLocation: 'Could not get your location for SOS. Check that location is on.',
  sosRejected: 'The server did not accept the SOS. Call your administrator.',
  sosStopped: 'This phone is no longer allowed to send locations.',

  // Battery
  batteryTitle: 'Battery optimisation is on',
  batteryBody:
    'Android may stop tracking to save battery. Allow VeeTrax Tracker to run without battery restrictions.',
  batteryButton: 'Allow unrestricted battery',

  // OEM autostart / background settings
  oemTitle: 'Keep tracking running',
  oemBody: (maker: string) => {
    const m = maker.toLowerCase();
    if (['xiaomi', 'redmi', 'poco'].includes(m))
      return 'Xiaomi / Redmi / POCO: turn ON Autostart for VeeTrax Tracker, then App info → Battery saver → No restrictions. Also lock the app in Recents (long-press its card → lock).';
    if (['oppo', 'realme'].includes(m))
      return 'Oppo / Realme: allow Auto launch (Startup manager) for VeeTrax Tracker, then App info → Battery usage → Allow background activity (and turn off "Optimise battery use").';
    if (['vivo', 'iqoo'].includes(m))
      return 'Vivo / iQOO: allow Autostart / Background startup for VeeTrax Tracker, then Battery → Background power consumption → Allow high background power usage.';
    if (m === 'oneplus')
      return 'OnePlus: App info → Battery usage → Allow background activity, and allow Auto launch. Lock the app in Recents.';
    if (m === 'samsung')
      return 'Samsung: Settings → Battery → Background usage limits → Never sleeping apps → add VeeTrax Tracker. Make sure it is not in Sleeping / Deep sleeping apps.';
    if (['huawei', 'honor'].includes(m))
      return 'Huawei / Honor: Battery → App launch → VeeTrax Tracker → Manage manually, and turn on Auto-launch, Secondary launch and Run in background.';
    return 'Some phones stop background apps to save battery. In the phone settings, allow VeeTrax Tracker to auto-start and to run in the background without battery restrictions.';
  },
  oemButton: 'Open phone settings',
  oemDone: "I've done this",

  // Permissions
  permissionsTitle: 'Permissions',
  permLocation: 'Location',
  permPrecise: 'Precise location',
  permBackground: 'Location all the time',
  permNotifications: 'Notifications',
  permGranted: 'Allowed',
  permDenied: 'Not allowed',
  permLocationOff: 'Location (GPS) is switched off on this phone.',
  openSettings: 'Open app settings',
  permBackgroundHelp: 'Choose "Allow all the time" under Location so tracking works when the app is closed.',

  // Disclosure (shown before the system permission dialogs; Google Play prominent disclosure)
  disclosureTitle: 'Location sharing',
  disclosureBody: [
    'VeeTrax Tracker collects this phone\'s location data to share it with the VeeTrax account this phone is activated for (your company, your family or your own account), even when the app is closed or not in use.',
    'While tracking is ON, your location, speed and battery level are sent to that VeeTrax account, where its users can see them. A notification is always shown while tracking.',
    'You can stop tracking at any time with the Stop button. Location is not collected while tracking is OFF.',
  ],
  disclosureNext: 'On the next screens, choose "While using the app", then "Allow all the time".',
  disclosureAgree: 'I understand, continue',
  disclosureCancel: 'Not now',
  permDeniedForeground: 'Location permission is needed to track this phone.',
  permDeniedBackground:
    'Tracking will run only while the app is open. To track when it is closed, allow location "All the time" in app settings.',

  // Account
  signOut: 'Sign out / deactivate this phone',
  signOutConfirmTitle: 'Deactivate this phone?',
  signOutConfirmBody: 'Tracking stops and you will need a new code to activate again.',
  cancel: 'Cancel',
  ok: 'OK',

  // Foreground service notification
  fgTitle: 'VeeTrax Tracker is sharing your location',
  fgBody: 'Tracking is on. Open the app to stop.',
} as const;
