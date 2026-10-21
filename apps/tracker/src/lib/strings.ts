/** All user-facing text (English only for now). Keep new strings here so translation is easy later. */
export const S = {
  appName: 'VeeTrax Tracker',

  // Activation
  activateTitle: 'Activate this phone',
  activateIntro:
    'Your administrator must first add this mobile number as a tracker in VeeTrax (Devices). Then enter the number below to get a 6-digit code.',
  mobileLabel: 'Mobile number',
  mobilePlaceholder: '98765 43210',
  mobileInvalid: 'Enter a 10-digit mobile number.',
  sendCode: 'Send code',
  codeLabel: '6-digit code',
  codeSentSms: (mobile: string) => `We sent a code by SMS to +${mobile}. It is valid for 10 minutes.`,
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

  // Home
  trackingOn: 'Tracking is ON',
  trackingOff: 'Tracking is OFF',
  startTracking: 'Start tracking',
  stopTracking: 'Stop tracking',
  stopConfirmTitle: 'Stop tracking?',
  stopConfirmBody: 'Your location will no longer be shared with your administrator.',
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
  filtered: 'Filtered out',
  filteredValue: (dropped: number, mock: number) => `${dropped} inaccurate / jumps${mock ? `, ${mock} fake GPS` : ''}`,
  notRunningTitle: 'Tracking stopped unexpectedly',
  notRunningBody: 'Android or the phone maker stopped the tracking service. Tap Start tracking again, then check the battery and autostart settings below.',

  // SOS
  sos: 'SOS',
  sosHint: 'Press and hold for 2 seconds',
  sosSending: 'Sending SOS…',
  sosSent: 'SOS sent to your administrator.',
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
    'VeeTrax Tracker collects this phone\'s location data to enable fleet and workforce tracking by your employer, even when the app is closed or not in use.',
    'While tracking is ON, your location, speed, and battery level are sent to your employer\'s VeeTrax account. A notification is always shown while tracking.',
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
