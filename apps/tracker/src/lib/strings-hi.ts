import type { Strings } from './strings';

/** Hindi text. Same keys as English in strings.ts (the compiler checks); brand names and phone menu names stay in English. */
export const hi: Strings = {
  appName: 'VeeTrax Tracker',

  // Activation
  activateTitle: 'इस फ़ोन को सक्रिय करें',
  activateIntro: 'इस फ़ोन का मोबाइल नंबर और अपना ई-मेल दर्ज करें। हम फ़ोन पर 6 अंकों का कोड भेजेंगे।',
  steps: ['अपना मोबाइल नंबर और ई-मेल दर्ज करें', 'SMS से मिला 6 अंकों का कोड लिखें', 'जब तक आप न रोकें, ट्रैकिंग बैकग्राउंड में चलती है', 'VeeTrax ऐप में अपना स्थान और इतिहास देखें'],
  mobileLabel: 'मोबाइल नंबर',
  emailLabel: 'ई-मेल (ज़रूरी)',
  emailRequired: 'अपना ई-मेल पता दर्ज करें।',
  emailHint: 'व्यक्तिगत / परिवार: फ़ोन इस ई-मेल के VeeTrax खाते में जोड़ा जाता है (ज़रूरत हो तो नया खाता बनता है)। कंपनी के फ़ोन कंपनी के खाते में ही रहते हैं; ई-मेल आपके संपर्क के रूप में रखा जाता है।',
  emailPlaceholder: 'you@example.com',
  emailLabelRegistered: 'ई-मेल',
  emailRegisteredHint: 'यह नंबर पहले से पंजीकृत है। विवरण वैसे ही रखें या बदलें।',
  emailKeep: (masked) => `${masked} से पंजीकृत है। इसे रखने के लिए खाली छोड़ें, या नया ई-मेल लिखें।`,
  emailInvalid: 'सही ई-मेल पता दर्ज करें।',
  nameLabel: 'आपका नाम (वैकल्पिक)',
  namePlaceholder: 'जैसे रवि',
  mobilePlaceholder: '98765 43210',
  mobileInvalid: '10 अंकों का मोबाइल नंबर दर्ज करें।',
  sendCode: 'कोड भेजें',
  codeLabel: '6 अंकों का कोड',
  codeSentSms: (mobile) => `हमने +${mobile} पर SMS से कोड भेजा है। यह 10 मिनट तक मान्य है।`,
  codeSentEmail: (to) => `हमने कोड ${to.join(', ')} पर ई-मेल किया है। उनसे कोड माँग लें; यह 10 मिनट तक मान्य है।`,
  codeNoSms: (mobile) => `SMS उपलब्ध नहीं है। अपने एडमिनिस्ट्रेटर से VeeTrax के Devices पेज से कोड पूछें (नंबर +${mobile})।`,
  codeHelp: 'SMS न मिले तो आपका एडमिनिस्ट्रेटर VeeTrax के Devices पेज से कोड बता सकता है।',
  codeInvalid: '6 अंकों का कोड दर्ज करें।',
  verify: 'सक्रिय करें',
  changeNumber: 'नंबर बदलें',
  resendCode: 'कोड दोबारा भेजें',
  networkError: 'सर्वर से संपर्क नहीं हो सका। अपना इंटरनेट कनेक्शन जाँचकर फिर कोशिश करें।',

  // Sign-out reasons
  reasonRevoked: 'ट्रैकिंग इसी नंबर वाले दूसरे फ़ोन पर चली गई है।',
  reasonInvalid: 'कृपया फिर से सक्रिय करें।',
  reasonInactive: 'आपके एडमिनिस्ट्रेटर ने ट्रैकिंग बंद कर दी है।',
  reasonSignedOut: 'यह फ़ोन निष्क्रिय कर दिया गया।',

  // Account details and the VeeTrax app
  mobile: 'मोबाइल',
  email: 'ई-मेल',
  accountType: 'खाता',
  accountTypes: { BUSINESS: 'कंपनी', INDIVIDUAL: 'व्यक्तिगत', FAMILY: 'परिवार' },
  freeTrialUntil: 'मुफ़्त ट्रैकिंग इस तारीख़ तक',
  licenceUntil: 'लाइसेंस इस तारीख़ तक',
  trialEnded: 'मुफ़्त अवधि समाप्त हो गई: इस फ़ोन का स्थान देखने के लिए VeeTrax ऐप में लाइसेंस लें।',
  viewInAppTitle: 'VeeTrax ऐप में अपनी ट्रैकिंग देखें',
  viewInAppBody: (email, mobile) => `इस फ़ोन का स्थान, इतिहास और अलर्ट देखने के लिए VeeTrax ऐप या app.veetrax.com में ${email ? `${email} या ` : ''}${mobile} पर आए OTP से साइन इन करें।`,
  openVeetrax: 'VeeTrax खोलें',
  privacyPolicy: 'निजता नीति',
  deleteAccount: 'खाता और डेटा हटाएँ',
  languageTitle: 'भाषा',

  // Home
  trackingOn: 'ट्रैकिंग चालू है',
  trackingOff: 'ट्रैकिंग बंद है',
  startTracking: 'ट्रैकिंग शुरू करें',
  stopTracking: 'ट्रैकिंग रोकें',
  statusOff: 'आपका स्थान साझा नहीं हो रहा है।',
  statusSent: (when) => `स्थान ${when} भेजा गया`,
  statusWaiting: 'पहले स्थान की प्रतीक्षा है…',
  statusStuck: (n) => `सर्वर से संपर्क नहीं हो पा रहा। ${n} पॉइंट सहेजे गए हैं, कोशिश जारी रहेगी।`,
  requiredShort: 'आपकी कंपनी को इस फ़ोन पर ट्रैकिंग ज़रूरी है।',
  attentionTitle: 'ध्यान दें',
  fix: 'ठीक करें',
  permMissingTitle: 'कुछ अनुमतियाँ नहीं दी गई हैं',
  permAllowAlways: 'स्थान की अनुमति हर समय के लिए दें',
  locationOffShort: 'स्थान (GPS) बंद है',
  detailsTitle: 'विवरण',
  profileTitle: 'प्रोफ़ाइल',
  menu: 'मेनू',
  signOutUnsent: (n) => `${n} स्थान अभी अपलोड नहीं हुए हैं और अभी न भेजे जा सके तो खो जाएँगे। हो सके तो पहले इंटरनेट से जुड़ें।`,
  attendanceTitle: 'उपस्थिति',
  shiftToday: (from, to) => `आज आपकी शिफ़्ट: ${from} से ${to} तक`,
  notCheckedIn: 'अभी चेक-इन नहीं हुआ है। शिफ़्ट के दौरान कार्यस्थल पर पहुँचते ही चेक-इन अपने आप हो जाता है।',
  stateInside: 'आप कार्यस्थल के अंदर हैं।',
  stateOut: 'आप कार्यस्थल से बाहर हैं।',
  stateNoSignal: 'इस फ़ोन से हाल का स्थान नहीं मिला। ट्रैकिंग चालू रखें।',
  checkedInAt: (time, site) => `${time} पर चेक-इन हुआ${site ? ` · ${site}` : ''}`,
  outingQuestion: (from, to, site) => `आप ${from} पर ${site ?? 'कार्यस्थल'} से बाहर गए${to ? ` और ${to} पर लौटे` : ''}। क्या यह काम के लिए था?`,
  outingOfficial: 'कार्यालय का काम',
  outingPersonal: 'निजी',
  outingNote: 'टिप्पणी जोड़ें (वैकल्पिक)',
  selfieTitle: 'चेक-इन सेल्फ़ी',
  selfieBody: 'आपका नियोक्ता चेक-इन पर सेल्फ़ी माँगता है। इसका उपयोग केवल उपस्थिति के लिए होता है।',
  selfieButton: 'सेल्फ़ी लें',
  selfieDone: (time) => `${time} पर सेल्फ़ी ली गई`,
  videoTitle: 'चेक-इन वीडियो',
  videoBody: 'आपका नियोक्ता चेक-इन पर 10 सेकंड का वीडियो माँगता है। उसी से एक फ़ोटो ली जाती है। इसका उपयोग केवल उपस्थिति के लिए होता है।',
  autoVideoBody: 'कैमरा खुलते ही यह अपने आप 10 सेकंड का वीडियो (बिना आवाज़) रिकॉर्ड करता है और उसी से एक फ़ोटो ली जाती है। इसका उपयोग केवल उपस्थिति के लिए होता है।',
  videoButton: 'वीडियो रिकॉर्ड करें',
  openCamera: 'कैमरा खोलें',
  startRecording: 'रिकॉर्डिंग शुरू करें',
  stopRecording: 'रोकें',
  recording: (s) => `रिकॉर्डिंग · ${s} सेकंड`,
  lookAtCamera: 'कैमरे की ओर देखें',
  sending: 'भेजा जा रहा है…',
  videoDone: (time) => `${time} पर वीडियो रिकॉर्ड हुआ`,
  cameraDenied: 'सेल्फ़ी लेने के लिए फ़ोन की सेटिंग में VeeTrax Tracker को कैमरे की अनुमति दें।',
  cameraFailed: 'कैमरा शुरू नहीं हुआ। कैमरा इस्तेमाल करने वाले दूसरे ऐप बंद करके फिर कोशिश करें।',
  requiredTitle: 'ट्रैकिंग ज़रूरी है',
  requiredBody: 'आपकी कंपनी को इस फ़ोन पर स्थान ट्रैकिंग ज़रूरी है, इसलिए इसे यहाँ से बंद नहीं किया जा सकता। कृपया अपने एडमिनिस्ट्रेटर से पूछें।',
  stopConfirmTitle: 'ट्रैकिंग रोकें?',
  stopConfirmBody: 'आपका स्थान अब आपके खाते या कंपनी के साथ साझा नहीं होगा।',
  lastFix: 'अंतिम स्थान',
  accuracy: 'सटीकता',
  speed: 'गति',
  waiting: 'अपलोड होना बाकी',
  lastUpload: 'अंतिम अपलोड',
  uploadError: 'अपलोड में समस्या',
  never: 'कभी नहीं',
  points: (n) => `${n} पॉइंट`,
  trackingFor: 'किसकी ट्रैकिंग',
  company: 'कंपनी',
  uploadNow: 'अभी अपलोड करें',
  mode: 'GPS मोड',
  modeMoving: 'चलते हुए (उच्च सटीकता)',
  modeStationary: 'रुका हुआ (बैटरी बचत)',
  filtered: 'चिह्नित (फिर भी भेजे गए)',
  filteredValue: (dropped, mock) => `${dropped} गलत / उछाल${mock ? `, ${mock} नकली GPS` : ''}`,
  notRunningTitle: 'ट्रैकिंग अचानक रुक गई',
  notRunningBody: 'Android या फ़ोन निर्माता ने ट्रैकिंग सेवा रोक दी। ट्रैकिंग शुरू करें पर फिर से टैप करें, फिर बैटरी और ऑटोस्टार्ट सेटिंग जाँचें।',
  ago: (n, unit) => `${n} ${{ s: 'सेकंड', min: 'मिनट', h: 'घंटे' }[unit]} पहले`,

  // SOS
  sos: 'SOS',
  sosHint: '2 सेकंड तक दबाकर रखें',
  sosSending: 'SOS भेजा जा रहा है…',
  sosSent: 'SOS आपके खाते या कंपनी को भेज दिया गया।',
  sosQueued: 'कनेक्शन नहीं है। SOS सहेज लिया गया है और जल्द से जल्द भेजा जाएगा।',
  sosNoLocation: 'SOS के लिए आपका स्थान नहीं मिल सका। जाँचें कि स्थान चालू है।',
  sosRejected: 'सर्वर ने SOS स्वीकार नहीं किया। अपने एडमिनिस्ट्रेटर को कॉल करें।',
  sosStopped: 'इस फ़ोन को अब स्थान भेजने की अनुमति नहीं है।',

  // Battery
  batteryTitle: 'बैटरी ऑप्टिमाइज़ेशन चालू है',

  // OEM autostart / background settings
  oemTitle: 'ट्रैकिंग चालू रखें',
  oemBody: (maker) => {
    const m = maker.toLowerCase();
    if (['xiaomi', 'redmi', 'poco'].includes(m))
      return 'Xiaomi / Redmi / POCO: VeeTrax Tracker के लिए Autostart चालू करें, फिर App info → Battery saver → No restrictions चुनें। Recents में भी ऐप को लॉक करें (उसके कार्ड को दबाकर रखें → लॉक)।';
    if (['oppo', 'realme'].includes(m))
      return 'Oppo / Realme: VeeTrax Tracker के लिए Auto launch (Startup manager) की अनुमति दें, फिर App info → Battery usage → Allow background activity चुनें ("Optimise battery use" बंद करें)।';
    if (['vivo', 'iqoo'].includes(m))
      return 'Vivo / iQOO: VeeTrax Tracker के लिए Autostart / Background startup की अनुमति दें, फिर Battery → Background power consumption → Allow high background power usage चुनें।';
    if (m === 'oneplus')
      return 'OnePlus: App info → Battery usage → Allow background activity चुनें और Auto launch की अनुमति दें। Recents में ऐप को लॉक करें।';
    if (m === 'samsung')
      return 'Samsung: Settings → Battery → Background usage limits → Never sleeping apps में VeeTrax Tracker जोड़ें। ध्यान रखें कि यह Sleeping / Deep sleeping apps में न हो।';
    if (['huawei', 'honor'].includes(m))
      return 'Huawei / Honor: Battery → App launch → VeeTrax Tracker → Manage manually चुनें और Auto-launch, Secondary launch और Run in background चालू करें।';
    return 'कुछ फ़ोन बैटरी बचाने के लिए बैकग्राउंड ऐप रोक देते हैं। फ़ोन की सेटिंग में VeeTrax Tracker को ऑटो-स्टार्ट और बिना बैटरी प्रतिबंध के बैकग्राउंड में चलने की अनुमति दें।';
  },
  oemButton: 'फ़ोन की सेटिंग खोलें',
  oemDone: 'मैंने यह कर लिया',

  // Permissions
  permissionsTitle: 'अनुमतियाँ',
  permLocation: 'स्थान',
  permPrecise: 'सटीक स्थान',
  permBackground: 'हर समय स्थान',
  permNotifications: 'सूचनाएँ',
  permGranted: 'अनुमति है',
  permDenied: 'अनुमति नहीं',
  permLocationOff: 'इस फ़ोन पर स्थान (GPS) बंद है।',
  openSettings: 'ऐप की सेटिंग खोलें',
  permBackgroundHelp: 'ऐप बंद होने पर भी ट्रैकिंग चले, इसके लिए Location में "Allow all the time" चुनें।',

  // Disclosure (shown before the system permission dialogs; Google Play prominent disclosure)
  disclosureTitle: 'स्थान साझा करना',
  disclosureBody: [
    'VeeTrax Tracker इस फ़ोन का स्थान डेटा इकट्ठा करता है ताकि उसे उस VeeTrax खाते (आपकी कंपनी, आपका परिवार या आपका अपना खाता) के साथ साझा किया जा सके जिसके लिए यह फ़ोन सक्रिय है, तब भी जब ऐप बंद हो या उपयोग में न हो।',
    'ट्रैकिंग चालू रहने पर आपका स्थान, गति और बैटरी स्तर उस VeeTrax खाते को भेजे जाते हैं, जहाँ उसके उपयोगकर्ता इन्हें देख सकते हैं। ट्रैकिंग के दौरान हमेशा एक सूचना दिखती है।',
    'आप रोकें बटन से कभी भी ट्रैकिंग रोक सकते हैं। ट्रैकिंग बंद होने पर स्थान इकट्ठा नहीं किया जाता।',
  ],
  disclosureNext: 'अगली स्क्रीन पर "While using the app" चुनें, फिर "Allow all the time" चुनें।',
  disclosureAgree: 'मैं समझ गया/गई, आगे बढ़ें',
  disclosureCancel: 'अभी नहीं',
  permDeniedForeground: 'इस फ़ोन को ट्रैक करने के लिए स्थान की अनुमति ज़रूरी है।',
  permDeniedBackground: 'ट्रैकिंग केवल ऐप खुला रहने पर चलेगी। ऐप बंद होने पर भी ट्रैक करने के लिए ऐप की सेटिंग में स्थान को "All the time" अनुमति दें।',

  // Account
  signOut: 'साइन आउट / इस फ़ोन को निष्क्रिय करें',
  signOutShort: 'साइन आउट',
  deactivatePhone: 'इस फ़ोन को निष्क्रिय करें',
  signOutConfirmTitle: 'इस फ़ोन को निष्क्रिय करें?',
  signOutConfirmBody: 'ट्रैकिंग रुक जाएगी और दोबारा सक्रिय करने के लिए नया कोड चाहिए होगा।',
  cancel: 'रद्द करें',
  ok: 'ठीक है',

  // Messages from the server, which always answers in English
  server: {
    'Enter a valid mobile number': 'सही मोबाइल नंबर दर्ज करें',
    'This number is not registered yet. Enter your e-mail address: the phone will be added to your VeeTrax account (or a new one).': 'यह नंबर अभी पंजीकृत नहीं है। अपना ई-मेल पता दर्ज करें: फ़ोन आपके VeeTrax खाते (या नए खाते) में जोड़ा जाएगा।',
    'The code has expired or was not requested. Ask for a new code.': 'कोड की अवधि समाप्त हो गई है या माँगा नहीं गया था। नया कोड माँगें।',
    'The code was already used. Ask for a new code.': 'यह कोड पहले ही इस्तेमाल हो चुका है। नया कोड माँगें।',
    'Too many wrong attempts. Ask for a new code.': 'बहुत बार गलत कोड डाला गया। नया कोड माँगें।',
    'Wrong code.': 'गलत कोड।',
    'Tracking for this number is switched off by your administrator.': 'आपके एडमिनिस्ट्रेटर ने इस नंबर की ट्रैकिंग बंद कर दी है।',
    'Tracking switched off by your administrator': 'आपके एडमिनिस्ट्रेटर ने ट्रैकिंग बंद कर दी है',
    'This number is not registered for tracking. Ask your administrator to add it in VeeTrax → Devices.': 'यह नंबर ट्रैकिंग के लिए पंजीकृत नहीं है। अपने एडमिनिस्ट्रेटर से इसे VeeTrax → Devices में जोड़ने को कहें।',
    'Too many codes for this number today. Try again tomorrow or ask your administrator.': 'आज इस नंबर के लिए बहुत कोड माँगे जा चुके हैं। कल फिर कोशिश करें या अपने एडमिनिस्ट्रेटर से पूछें।',
    'Too many codes for this number today. Try again tomorrow.': 'आज इस नंबर के लिए बहुत कोड माँगे जा चुके हैं। कल फिर कोशिश करें।',
    'Please wait 30 seconds before asking for a new code.': 'नया कोड माँगने से पहले 30 सेकंड रुकें।',
    'A selfie is not needed': 'सेल्फ़ी की ज़रूरत नहीं है',
    'Attendance is off for this phone': 'इस फ़ोन के लिए उपस्थिति बंद है',
    'Take a photo': 'फ़ोटो लें',
    'Take the selfie at your work site': 'सेल्फ़ी अपने कार्यस्थल पर लें',
    'The photo is larger than 8 MB': 'फ़ोटो 8 MB से बड़ी है',
    'Upload a photo (JPEG, PNG, WebP)': 'फ़ोटो अपलोड करें (JPEG, PNG, WebP)',
    'This time outside is no longer listed': 'बाहर बिताया यह समय अब सूची में नहीं है',
    'Your administrator has already decided this': 'आपके एडमिनिस्ट्रेटर ने इस पर पहले ही निर्णय ले लिया है',
  },
};
