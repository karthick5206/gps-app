/**
 * Photo feature switches (Settings → Features on the web and in the VeeTrax app, Platform → Companies) and the API
 * messages they show. Keys are the English source strings. Rows are [English, Hindi, Tamil]. (The Tracker app keeps its
 * own strings in apps/tracker.)
 */
const ROWS: [string, string, string][] = [
  ['Features', 'सुविधाएँ', 'அம்சங்கள்'],
  ['Person photos', 'व्यक्ति की फ़ोटो', 'நபர் படங்கள்'],
  ['Photo features', 'फ़ोटो सुविधाएँ', 'பட அம்சங்கள்'],
  [
    'Choose which photo features this account uses. Both are off until switched on. Switching a feature off only hides it: photos and notes already saved are kept and come back when it is switched on again.',
    'चुनें कि यह खाता कौन-सी फ़ोटो सुविधाएँ इस्तेमाल करे। चालू किए जाने तक दोनों बंद रहती हैं। किसी सुविधा को बंद करने से वह सिर्फ़ छिपती है: पहले से सहेजी गई फ़ोटो और नोट्स रखे जाते हैं और दोबारा चालू करने पर वापस दिखते हैं।',
    'இந்தக் கணக்கு எந்தப் பட அம்சங்களைப் பயன்படுத்த வேண்டும் என்பதைத் தேர்ந்தெடுக்கவும். இயக்கும் வரை இரண்டும் அணைந்திருக்கும். ஒரு அம்சத்தை அணைத்தால் அது மறைக்கப்படும் மட்டுமே: ஏற்கனவே சேமித்த படங்களும் குறிப்புகளும் வைக்கப்பட்டு, மீண்டும் இயக்கும்போது திரும்பத் தெரியும்.',
  ],
  [
    'Photos of people, pets and assets: upload in the object form and the Tracker app, photo markers and the photo on hover on the maps.',
    'व्यक्तियों, पालतू जानवरों और एसेट की फ़ोटो: ऑब्जेक्ट फ़ॉर्म और ट्रैकर ऐप में अपलोड, नक्शों पर फ़ोटो मार्कर और होवर करने पर फ़ोटो।',
    'நபர்கள், செல்லப்பிராணிகள் மற்றும் சொத்துகளின் படங்கள்: பொருள் படிவத்திலும் டிராக்கர் செயலியிலும் பதிவேற்றம், வரைபடங்களில் பட குறிப்பான்கள் மற்றும் மேலே வைத்தால் படம்.',
  ],
  [
    'Photos with a note and their place ("Add photo here"): the Photos & notes page and the photo-note layers on the live map and in history.',
    'नोट और जगह के साथ फ़ोटो ("यहाँ फ़ोटो जोड़ें"): फ़ोटो और नोट्स पेज, और लाइव मैप व इतिहास में फ़ोटो-नोट लेयर।',
    'குறிப்பும் இடமும் கொண்ட படங்கள் ("இங்கே படம் சேர்"): படங்கள் & குறிப்புகள் பக்கம், நேரலை வரைபடத்திலும் வரலாற்றிலும் படக் குறிப்பு அடுக்குகள்.',
  ],
  ['Feature switched on', 'सुविधा चालू की गई', 'அம்சம் இயக்கப்பட்டது'],
  ['Feature switched off', 'सुविधा बंद की गई', 'அம்சம் அணைக்கப்பட்டது'],
  ['Only an administrator can change these.', 'इन्हें केवल व्यवस्थापक बदल सकता है।', 'இவற்றை நிர்வாகி மட்டுமே மாற்ற முடியும்.'],
  ['Person photos are switched off for this account.', 'इस खाते के लिए व्यक्ति की फ़ोटो बंद हैं।', 'இந்தக் கணக்கிற்கு நபர் படங்கள் அணைக்கப்பட்டுள்ளன.'],
  ['Photo notes are switched off for this account.', 'इस खाते के लिए फ़ोटो नोट्स बंद हैं।', 'இந்தக் கணக்கிற்குப் படக் குறிப்புகள் அணைக்கப்பட்டுள்ளன.'],
  ['Only an administrator can change this.', 'इसे केवल व्यवस्थापक बदल सकता है।', 'இதை நிர்வாகி மட்டுமே மாற்ற முடியும்.'],
  ['Only the account owner can change this.', 'इसे केवल खाते का मालिक बदल सकता है।', 'இதைக் கணக்கு உரிமையாளர் மட்டுமே மாற்ற முடியும்.'],
  ['Ask your administrator to change this.', 'इसे बदलने के लिए अपने व्यवस्थापक से कहें।', 'இதை மாற்ற உங்கள் நிர்வாகியிடம் கேளுங்கள்.'],
  ['Off by default for every company. The company admin can also switch these in Settings → Features.', 'हर कंपनी के लिए डिफ़ॉल्ट रूप से बंद। कंपनी व्यवस्थापक इन्हें सेटिंग्स → सुविधाएँ में भी बदल सकता है।', 'ஒவ்வொரு நிறுவனத்திற்கும் இயல்பாக அணைந்திருக்கும். நிறுவன நிர்வாகியும் இவற்றை அமைப்புகள் → அம்சங்கள் பகுதியில் மாற்றலாம்.'],
  ['Person photos on', 'व्यक्ति की फ़ोटो चालू', 'நபர் படங்கள் இயக்கத்தில்'],
  ['Photo notes on', 'फ़ोटो नोट्स चालू', 'படக் குறிப்புகள் இயக்கத்தில்'],
];

export const PHOTO_FEATURES_HI: Record<string, string> = Object.fromEntries(ROWS.map(([en, hi]) => [en, hi]));
export const PHOTO_FEATURES_TA: Record<string, string> = Object.fromEntries(ROWS.map(([en, , ta]) => [en, ta]));
/** English keys of this module. */
export const PHOTO_FEATURES_KEYS: readonly string[] = ROWS.map(([en]) => en);
