import type { LanguageCode, Strings } from './strings';

/**
 * iPhone wording for the texts that describe Android behaviour (permission names, the tracking notification, the
 * service being killed). Applied over the language's strings on iOS only; phone menu names stay in English, as in
 * the Android texts.
 */
export const IOS_OVERRIDES: Record<LanguageCode, Partial<Strings>> = {
  en: {
    permAllowAlways: 'Allow location Always',
    notRunningBody: 'Tracking is not running. Tap Start tracking again, and keep location set to "Always" for VeeTrax Tracker.',
    permBackground: 'Location Always',
    permBackgroundHelp: 'Choose "Always" under Location so tracking works when the app is closed.',
    disclosureBody: [
      'VeeTrax Tracker collects this phone\'s location data to share it with the VeeTrax account this phone is activated for (your company, your family or your own account), even when the app is closed or not in use.',
      'While tracking is ON, your location, speed and battery level are sent to that VeeTrax account, where its users can see them. The iPhone shows the location indicator while tracking.',
      'You can stop tracking at any time with the Stop button. Location is not collected while tracking is OFF.',
    ],
    disclosureNext: 'On the next screens, choose "Allow While Using App", then "Change to Always Allow".',
    permDeniedBackground: 'Tracking will run only while the app is open. To track when it is closed, set location to "Always" in app settings.',
  },
  hi: {
    permAllowAlways: 'स्थान की अनुमति Always के लिए दें',
    notRunningBody: 'ट्रैकिंग नहीं चल रही है। ट्रैकिंग शुरू करें पर फिर से टैप करें, और VeeTrax Tracker के लिए स्थान "Always" पर रखें।',
    permBackground: 'स्थान Always',
    permBackgroundHelp: 'ऐप बंद होने पर भी ट्रैकिंग चले, इसके लिए Location में "Always" चुनें।',
    disclosureBody: [
      'VeeTrax Tracker इस फ़ोन का स्थान डेटा इकट्ठा करता है ताकि उसे उस VeeTrax खाते (आपकी कंपनी, आपका परिवार या आपका अपना खाता) के साथ साझा किया जा सके जिसके लिए यह फ़ोन सक्रिय है, तब भी जब ऐप बंद हो या उपयोग में न हो।',
      'ट्रैकिंग चालू रहने पर आपका स्थान, गति और बैटरी स्तर उस VeeTrax खाते को भेजे जाते हैं, जहाँ उसके उपयोगकर्ता इन्हें देख सकते हैं। ट्रैकिंग के दौरान iPhone स्थान संकेतक दिखाता है।',
      'आप रोकें बटन से कभी भी ट्रैकिंग रोक सकते हैं। ट्रैकिंग बंद होने पर स्थान इकट्ठा नहीं किया जाता।',
    ],
    disclosureNext: 'अगली स्क्रीन पर "Allow While Using App" चुनें, फिर "Change to Always Allow" चुनें।',
    permDeniedBackground: 'ट्रैकिंग केवल ऐप खुला रहने पर चलेगी। ऐप बंद होने पर भी ट्रैक करने के लिए ऐप की सेटिंग में स्थान को "Always" पर रखें।',
  },
  ta: {
    permAllowAlways: 'இருப்பிடத்தை Always என அனுமதிக்கவும்',
    notRunningBody: 'கண்காணிப்பு இயங்கவில்லை. கண்காணிப்பைத் தொடங்கு என்பதை மீண்டும் தட்டி, VeeTrax Tracker-க்கு இருப்பிடத்தை "Always" என வைத்திருக்கவும்.',
    permBackground: 'இருப்பிடம் Always',
    permBackgroundHelp: 'செயலி மூடப்பட்டிருக்கும்போதும் கண்காணிப்பு இயங்க, Location-இல் "Always" என்பதைத் தேர்ந்தெடுக்கவும்.',
    disclosureBody: [
      'இந்த ஃபோன் செயல்படுத்தப்பட்ட VeeTrax கணக்குடன் (உங்கள் நிறுவனம், குடும்பம் அல்லது உங்கள் சொந்தக் கணக்கு) பகிர, செயலி மூடப்பட்டிருந்தாலும் பயன்பாட்டில் இல்லாவிட்டாலும், VeeTrax Tracker இந்த ஃபோனின் இருப்பிடத் தரவைச் சேகரிக்கிறது.',
      'கண்காணிப்பு இயக்கத்தில் இருக்கும்போது உங்கள் இருப்பிடம், வேகம், பேட்டரி நிலை ஆகியவை அந்த VeeTrax கணக்குக்கு அனுப்பப்படும், அதன் பயனர்கள் அவற்றைப் பார்க்கலாம். கண்காணிப்பின்போது iPhone இருப்பிடக் குறியைக் காட்டும்.',
      'நிறுத்து பொத்தானால் எப்போது வேண்டுமானாலும் கண்காணிப்பை நிறுத்தலாம். கண்காணிப்பு நிறுத்தத்தில் இருக்கும்போது இருப்பிடம் சேகரிக்கப்படாது.',
    ],
    disclosureNext: 'அடுத்த திரைகளில் "Allow While Using App", பிறகு "Change to Always Allow" என்பதைத் தேர்ந்தெடுக்கவும்.',
    permDeniedBackground: 'செயலி திறந்திருக்கும்போது மட்டுமே கண்காணிப்பு இயங்கும். மூடப்பட்டிருக்கும்போதும் கண்காணிக்க, செயலி அமைப்புகளில் இருப்பிடத்தை "Always" என வைக்கவும்.',
  },
};
