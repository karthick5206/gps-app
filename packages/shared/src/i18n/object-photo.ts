/**
 * Person photos (avatars): the web object form / live map drawer and the API messages they show. Keys are the English
 * source strings. Rows are [English, Hindi, Tamil]. (The Tracker app keeps its own strings in apps/tracker.)
 */
const ROWS: [string, string, string][] = [
  ['Add photo', 'फ़ोटो जोड़ें', 'படம் சேர்'],
  ['Change photo', 'फ़ोटो बदलें', 'படத்தை மாற்று'],
  ['Remove photo', 'फ़ोटो हटाएँ', 'படத்தை நீக்கு'],
  ['Photo saved', 'फ़ोटो सहेजी गई', 'படம் சேமிக்கப்பட்டது'],
  ['Photo removed', 'फ़ोटो हटा दी गई', 'படம் நீக்கப்பட்டது'],
  ['Choose a photo', 'फ़ोटो चुनें', 'ஒரு படத்தைத் தேர்ந்தெடுக்கவும்'],
  ['Save first, then add a photo.', 'पहले सहेजें, फिर फ़ोटो जोड़ें।', 'முதலில் சேமித்து, பின் படத்தைச் சேர்க்கவும்.'],
  [
    'JPEG, PNG or WebP, up to 5 MB. Cropped square; location and camera details are removed.',
    'JPEG, PNG या WebP, अधिकतम 5 MB। फ़ोटो वर्गाकार काटी जाती है; स्थान और कैमरे की जानकारी हटा दी जाती है।',
    'JPEG, PNG அல்லது WebP, அதிகபட்சம் 5 MB. சதுரமாக வெட்டப்படும்; இருப்பிடம் மற்றும் கேமரா விவரங்கள் நீக்கப்படும்.',
  ],
  ['Upload a JPEG, PNG or WebP photo', 'JPEG, PNG या WebP फ़ोटो अपलोड करें', 'JPEG, PNG அல்லது WebP படத்தைப் பதிவேற்றவும்'],
  ['The photo is larger than 5 MB', 'फ़ोटो 5 MB से बड़ी है', 'படம் 5 MB-ஐ விடப் பெரியது'],
  ['Choose a photo to upload', 'अपलोड करने के लिए फ़ोटो चुनें', 'பதிவேற்ற ஒரு படத்தைத் தேர்ந்தெடுக்கவும்'],
  ['This photo could not be read. Try another one.', 'यह फ़ोटो पढ़ी नहीं जा सकी। कोई दूसरी फ़ोटो आज़माएँ।', 'இந்தப் படத்தைப் படிக்க முடியவில்லை. வேறொன்றை முயற்சிக்கவும்.'],
  ['Only people, pets and assets can have a photo', 'केवल व्यक्ति, पालतू जानवर और एसेट की फ़ोटो हो सकती है', 'நபர்கள், செல்லப்பிராணிகள் மற்றும் சொத்துகளுக்கு மட்டுமே படம் இருக்க முடியும்'],
  ['The file content does not match its type', 'फ़ाइल की सामग्री उसके प्रकार से मेल नहीं खाती', 'கோப்பின் உள்ளடக்கம் அதன் வகையுடன் பொருந்தவில்லை'],
];

export const OBJECT_PHOTO_HI: Record<string, string> = Object.fromEntries(ROWS.map(([en, hi]) => [en, hi]));
export const OBJECT_PHOTO_TA: Record<string, string> = Object.fromEntries(ROWS.map(([en, , ta]) => [en, ta]));
/** English keys of this module (the i18n completeness test reads them). */
export const OBJECT_PHOTO_KEYS: readonly string[] = ROWS.map(([en]) => en);
