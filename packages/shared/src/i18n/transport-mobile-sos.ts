/**
 * Hindi and Tamil strings of the r114 mobile SOS fixes (passenger SOS on every screen and offline, driver SOS button,
 * read-only dispatcher incident screen). Own file so parallel work does not conflict; index.ts merges it (entries in
 * hi.ts / ta.ts win). Keys are the English source strings; keep {{placeholders}} unchanged. Honest wording: nothing
 * here says help is coming.
 */
export const TRANSPORT_MOBILE_SOS_HI: Record<string, string> = {
  'Hold the red button for 2 seconds to alert the dispatcher. The SOS is saved on this phone first and sent as soon as there is a connection.':
    'डिस्पैचर को सूचित करने के लिए लाल बटन 2 सेकंड तक दबाए रखें। SOS पहले इस फ़ोन में सहेजा जाता है और कनेक्शन मिलते ही भेजा जाता है।',
  'Hold the red button for 2 seconds to alert the transport desk. The SOS is saved on this phone first and sent as soon as there is a connection.':
    'ट्रांसपोर्ट डेस्क को सूचित करने के लिए लाल बटन 2 सेकंड तक दबाए रखें। SOS पहले इस फ़ोन में सहेजा जाता है और कनेक्शन मिलते ही भेजा जाता है।',
  'Your current trip is sent with the SOS.': 'आपकी मौजूदा यात्रा SOS के साथ भेजी जाती है।',
  'No current trip is known on this phone. The SOS is sent without a trip.': 'इस फ़ोन पर कोई मौजूदा यात्रा ज्ञात नहीं है। SOS बिना यात्रा के भेजा जाता है।',
  'This app does not send your phone’s location with the SOS.': 'यह ऐप SOS के साथ आपके फ़ोन का स्थान नहीं भेजता।',
  'Opens the SOS screen': 'SOS स्क्रीन खोलता है',
  'An SOS on this phone has not been sent yet. It is sent after you sign in again.': 'इस फ़ोन का एक SOS अभी तक नहीं भेजा गया है। आपके दोबारा साइन इन करने के बाद यह भेजा जाएगा।',
  'You can sign in again when you are online.': 'ऑनलाइन होने पर आप फिर से साइन इन कर सकते हैं।',
  'No connection': 'कोई कनेक्शन नहीं',
  'VeeTrax cannot reach the server right now. You can still raise an SOS: it is saved on this phone and sent as soon as the connection returns.':
    'VeeTrax अभी सर्वर तक नहीं पहुँच पा रहा है। आप फिर भी SOS भेज सकते हैं: यह इस फ़ोन में सहेजा जाता है और कनेक्शन लौटते ही भेजा जाता है।',
  'Driver SOS': 'ड्राइवर SOS',
  'Passenger SOS': 'यात्री SOS',
  'SOS not available': 'SOS उपलब्ध नहीं',
  'This SOS was not found, or you no longer have access to it.': 'यह SOS नहीं मिला, या अब आपके पास इसकी पहुँच नहीं है।',
  'Raised by': 'किसने भेजा',
  'Raised at': 'भेजने का समय',
  'Received by VeeTrax at': 'VeeTrax को मिलने का समय',
  'Last known position': 'अंतिम ज्ञात स्थान',
  'No position with this SOS': 'इस SOS के साथ कोई स्थान नहीं',
  'This screen is read-only. Acknowledge and resolve the SOS in VeeTrax on the web (Incidents & SOS).':
    'यह स्क्रीन केवल देखने के लिए है। SOS को वेब पर VeeTrax में स्वीकार करें और हल करें (घटनाएँ और SOS)।',
};

export const TRANSPORT_MOBILE_SOS_TA: Record<string, string> = {
  'Hold the red button for 2 seconds to alert the dispatcher. The SOS is saved on this phone first and sent as soon as there is a connection.':
    'அனுப்புநருக்குத் தெரிவிக்க சிவப்புப் பொத்தானை 2 விநாடிகள் அழுத்திப் பிடிக்கவும். SOS முதலில் இந்தத் தொலைபேசியில் சேமிக்கப்பட்டு, இணைப்பு கிடைத்தவுடன் அனுப்பப்படும்.',
  'Hold the red button for 2 seconds to alert the transport desk. The SOS is saved on this phone first and sent as soon as there is a connection.':
    'போக்குவரத்து மேசைக்குத் தெரிவிக்க சிவப்புப் பொத்தானை 2 விநாடிகள் அழுத்திப் பிடிக்கவும். SOS முதலில் இந்தத் தொலைபேசியில் சேமிக்கப்பட்டு, இணைப்பு கிடைத்தவுடன் அனுப்பப்படும்.',
  'Your current trip is sent with the SOS.': 'உங்கள் தற்போதைய பயணம் SOS உடன் அனுப்பப்படும்.',
  'No current trip is known on this phone. The SOS is sent without a trip.': 'இந்தத் தொலைபேசியில் தற்போதைய பயணம் எதுவும் தெரியவில்லை. SOS பயணம் இல்லாமல் அனுப்பப்படும்.',
  'This app does not send your phone’s location with the SOS.': 'இந்தச் செயலி SOS உடன் உங்கள் தொலைபேசியின் இருப்பிடத்தை அனுப்பாது.',
  'Opens the SOS screen': 'SOS திரையைத் திறக்கும்',
  'An SOS on this phone has not been sent yet. It is sent after you sign in again.': 'இந்தத் தொலைபேசியில் உள்ள ஒரு SOS இன்னும் அனுப்பப்படவில்லை. நீங்கள் மீண்டும் உள்நுழைந்த பிறகு அது அனுப்பப்படும்.',
  'You can sign in again when you are online.': 'இணைப்பு கிடைக்கும்போது மீண்டும் உள்நுழையலாம்.',
  'No connection': 'இணைப்பு இல்லை',
  'VeeTrax cannot reach the server right now. You can still raise an SOS: it is saved on this phone and sent as soon as the connection returns.':
    'VeeTrax இப்போது சேவையகத்தை அடைய முடியவில்லை. நீங்கள் இன்னும் SOS அனுப்பலாம்: அது இந்தத் தொலைபேசியில் சேமிக்கப்பட்டு, இணைப்பு திரும்பியவுடன் அனுப்பப்படும்.',
  'Driver SOS': 'ஓட்டுநர் SOS',
  'Passenger SOS': 'பயணி SOS',
  'SOS not available': 'SOS கிடைக்கவில்லை',
  'This SOS was not found, or you no longer have access to it.': 'இந்த SOS கிடைக்கவில்லை, அல்லது அதற்கான அணுகல் இனி உங்களுக்கு இல்லை.',
  'Raised by': 'அனுப்பியவர்',
  'Raised at': 'அனுப்பிய நேரம்',
  'Received by VeeTrax at': 'VeeTrax பெற்ற நேரம்',
  'Last known position': 'கடைசியாகத் தெரிந்த இருப்பிடம்',
  'No position with this SOS': 'இந்த SOS உடன் இருப்பிடம் இல்லை',
  'This screen is read-only. Acknowledge and resolve the SOS in VeeTrax on the web (Incidents & SOS).':
    'இந்தத் திரை பார்வைக்கு மட்டுமே. SOS-ஐ இணையத்தில் VeeTrax-இல் ஒப்புக்கொண்டு தீர்க்கவும் (சம்பவங்கள் & SOS).',
};
