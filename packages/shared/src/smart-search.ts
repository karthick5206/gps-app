/**
 * Ask VeeTrax (smart search, no AI): reads a typed or spoken question into an intent, a vehicle text and a time, in
 * English, Tamil or Hindi keywords. The API runs the matching query (see apps/api/src/smart-search).
 */

export const SEARCH_INTENTS = ['WHERE', 'DISTANCE', 'IDLE', 'OVERSPEED', 'OFFLINE', 'TRIPS', 'ALERTS', 'DOCUMENTS', 'NIGHT', 'BATTERY', 'CHARGING', 'STATUS'] as const;
export type SearchIntent = (typeof SEARCH_INTENTS)[number];

/** A time the question refers to, resolved by the API in the company's time zone. */
export type SearchTime =
  | { kind: 'now' }
  | { kind: 'day'; offset: number; atMin?: number } // 0 = today, -1 = yesterday; atMin = minutes after midnight
  | { kind: 'date'; day: string; atMin?: number } // YYYY-MM-DD
  | { kind: 'week'; offset: number } // 0 = this week (Mon–today), -1 = last week
  | { kind: 'month'; offset: number }
  | { kind: 'lastDays'; days: number }
  | { kind: 'lastNight' };

export interface ParsedQuery {
  intent: SearchIntent;
  /** Words left after removing keywords: the vehicle / person to look for ('' = whole fleet). */
  vehicle: string;
  time: SearchTime | null;
}

/** Keyword lists per intent (lower case; Tamil / Hindi words included). First match in this order wins. */
const INTENT_WORDS: [SearchIntent, string[]][] = [
  ['NIGHT', ['night', 'midnight', 'இரவு', 'रात']],
  ['OFFLINE', ['offline', 'not reporting', 'no signal', 'not working', 'disconnected', 'ஆஃப்லைன்', 'ऑफलाइन']],
  ['CHARGING', ['charging', 'charger', 'சார்ஜ்', 'चार्ज']],
  ['BATTERY', ['battery', 'பேட்டரி', 'बैटरी']],
  ['DOCUMENTS', ['document', 'documents', 'insurance', 'permit', 'fitness', 'fc', 'pollution', 'puc', 'service due', 'services', 'service', 'renewal', 'expiry', 'expiring', 'ஆவணம்', 'காப்பீடு', 'दस्तावेज़', 'बीमा']],
  ['OVERSPEED', ['overspeed', 'over speed', 'speeding', 'too fast', 'rash', 'அதிவேகம்', 'ओवरस्पीड', 'तेज़']],
  ['IDLE', ['idle', 'idling', 'idled', 'waiting', 'சும்மா', 'ஐடில்', 'आइडल']],
  ['ALERTS', ['alert', 'alerts', 'alarm', 'alarms', 'sos', 'எச்சரிக்கை', 'अलर्ट']],
  ['TRIPS', ['trip', 'trips', 'journey', 'journeys', 'பயணம்', 'யாத்திரை', 'यात्रा', 'ट्रिप']],
  ['DISTANCE', ['km', 'kms', 'kilometre', 'kilometres', 'kilometer', 'kilometers', 'distance', 'ran', 'run', 'travelled', 'traveled', 'mileage', 'கிமீ', 'கி.மீ', 'தூரம்', 'किमी', 'दूरी', 'किलोमीटर']],
  ['WHERE', ['where', 'location', 'locate', 'position', 'address', 'find', 'எங்கே', 'எங்க', 'இருப்பிடம்', 'कहाँ', 'कहां', 'लोकेशन']],
];

/** Filler words removed before matching the vehicle. */
const STOP = new Set(
  'is was are were the a an of for my our me show tell give list which what who how many much most least top vehicle vehicles car cars truck trucks bike bikes bus buses all any did does do has have had in on at by to from between and with this last today yesterday now week month days day night ago please pls get today\'s current currently right was it its there here than more less moved move moving went gone go due low high status details info report reports latest recent running parked stopped'.split(' '),
);

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const ASCII = /^[a-z0-9 .']+$/;
const boundary = (word: string) => new RegExp(`(^|[^a-z0-9])${word.replace(/[.']/g, '\const has = (text: string, word: string) =>')}(?=[^a-z0-9]|$)`, 'g');
/** Removes a whole word (English) or the phrase (Tamil / Hindi) from the text. */
const strip = (text: string, word: string) => (ASCII.test(word) ? text.replace(boundary(word), '$1 ') : text.split(word).join(' '));
const has = (text: string, word: string) => (/^[a-z0-9 .']+$/.test(word) ? new RegExp(`(^|[^a-z0-9])${word.replace(/[.']/g, '\\$&')}([^a-z0-9]|$)`).test(text) : text.includes(word));

/** Time of day: "3 pm", "3:30pm", "15:30", "at 9" → minutes after midnight. */
function timeOfDay(text: string): { min: number; match: string } | null {
  const m = /(?:^|\s)(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|மணி|बजे)(?=\s|$)/.exec(text) ?? /(?:^|\s)(?:at\s+)?(\d{1,2}):(\d{2})(?=\s|$)/.exec(text) ?? /(?:^|\s)at\s+(\d{1,2})(?=\s|$)/.exec(text);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3];
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return { min: h * 60 + min, match: m[0] };
}

/** Date like "30 oct", "oct 30", "30/10", "30-10-2026" → YYYY-MM-DD (year defaults to `year`). */
function dateOf(text: string, year: number): { day: string; match: string } | null {
  const pad = (n: number) => String(n).padStart(2, '0');
  let m = new RegExp(`(?:^|\\s)(\\d{1,2})\\s*(${MONTHS.join('|')})[a-z]*(?:\\s+(\\d{4}))?(?=\\s|$)`).exec(text);
  if (m) return { day: `${m[3] ?? year}-${pad(MONTHS.indexOf(m[2]) + 1)}-${pad(Number(m[1]))}`, match: m[0] };
  m = new RegExp(`(?:^|\\s)(${MONTHS.join('|')})[a-z]*\\s+(\\d{1,2})(?:\\s+(\\d{4}))?(?=\\s|$)`).exec(text);
  if (m) return { day: `${m[3] ?? year}-${pad(MONTHS.indexOf(m[1]) + 1)}-${pad(Number(m[2]))}`, match: m[0] };
  m = /(?:^|\s)(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?(?=\s|$)/.exec(text);
  if (m && Number(m[2]) <= 12 && Number(m[1]) <= 31) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : year;
    return { day: `${y}-${pad(Number(m[2]))}-${pad(Number(m[1]))}`, match: m[0] };
  }
  return null;
}

/** Reads a question. `year` is the current year (for dates without one). */
export function parseQuery(input: string, year: number = new Date().getFullYear()): ParsedQuery {
  let text = ` ${input.toLowerCase().replace(/[?!,;"]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
  const remove = (s: string) => {
    text = text.replace(s, ' ');
  };

  // Time.
  let time: SearchTime | null = null;
  const tod = timeOfDay(text.trim());
  if (tod) remove(tod.match.trim());
  const date = dateOf(text.trim(), year);
  if (date) {
    remove(date.match.trim());
    time = { kind: 'date', day: date.day, ...(tod ? { atMin: tod.min } : {}) };
  } else if (has(text, 'last night') || has(text, 'நேற்று இரவு') || has(text, 'कल रात')) {
    time = { kind: 'lastNight' };
  } else if (has(text, 'yesterday') || has(text, 'நேற்று') || has(text, 'कल')) {
    time = { kind: 'day', offset: -1, ...(tod ? { atMin: tod.min } : {}) };
  } else if (has(text, 'last week') || has(text, 'கடந்த வாரம்') || has(text, 'पिछले हफ्ते')) {
    time = { kind: 'week', offset: -1 };
  } else if (has(text, 'this week') || has(text, 'week') || has(text, 'இந்த வாரம்') || has(text, 'हफ्ते') || has(text, 'सप्ताह')) {
    time = { kind: 'week', offset: 0 };
  } else if (has(text, 'last month') || has(text, 'கடந்த மாதம்') || has(text, 'पिछले महीने')) {
    time = { kind: 'month', offset: -1 };
  } else if (has(text, 'this month') || has(text, 'month') || has(text, 'மாதம்') || has(text, 'महीने')) {
    time = { kind: 'month', offset: 0 };
  } else {
    const ld = /(?:last|past)\s+(\d{1,2})\s+days?/.exec(text);
    if (ld) {
      remove(ld[0]);
      time = { kind: 'lastDays', days: Math.min(31, Math.max(1, Number(ld[1]))) };
    } else if (has(text, 'today') || has(text, 'இன்று') || has(text, 'आज')) {
      time = { kind: 'day', offset: 0, ...(tod ? { atMin: tod.min } : {}) };
    } else if (tod) {
      time = { kind: 'day', offset: 0, atMin: tod.min };
    } else if (has(text, 'now') || has(text, 'இப்போது') || has(text, 'अभी')) {
      time = { kind: 'now' };
    }
  }

  // Intent.
  let intent: SearchIntent | null = null;
  for (const [i, words] of INTENT_WORDS) {
    const w = words.find((x) => has(text, x));
    if (w) {
      intent = i;
      break;
    }
  }
  // Strip every keyword and time word so only the vehicle is left.
  for (const [, words] of INTENT_WORDS) for (const w of words) if (has(text, w)) text = strip(text, w);
  for (const w of ['last night', 'yesterday', 'today', 'this week', 'last week', 'this month', 'last month', 'நேற்று இரவு', 'நேற்று', 'இன்று', 'இந்த வாரம்', 'கடந்த வாரம்', 'கடந்த மாதம்', 'மாதம்', 'कल रात', 'कल', 'आज', 'हफ्ते', 'सप्ताह', 'पिछले', 'महीने', 'இப்போது', 'अभी']) text = strip(text, w);
  const vehicle = text
    .split(' ')
    .filter((t) => t && !STOP.has(t))
    .join(' ')
    .trim();

  if (!intent) intent = vehicle ? (time && time.kind !== 'now' ? 'WHERE' : 'STATUS') : 'STATUS';
  if (intent === 'NIGHT' && !time) time = { kind: 'lastNight' };
  return { intent, vehicle, time };
}

/** Plate / name key for matching: letters and digits only, lower case ("TN 09-BB 9421" → "tn09bb9421"). */
export const searchKey = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9஀-௿ऀ-ॿ]/g, '');

export type SearchCard =
  | {
      kind: 'location';
      objectId: string;
      name: string;
      plateNumber: string | null;
      lat: number;
      lng: number;
      at: string | null;
      address: string | null;
      status: string | null;
      speedKph: number | null;
      note: string | null;
    }
  | { kind: 'stats'; items: { label: string; value: string }[] }
  | { kind: 'table'; columns: string[]; rows: { objectId: string | null; cells: string[] }[] };

export interface SearchLink {
  label: string;
  /** Web path (e.g. /history?objectId=…&from=…&to=…); the mobile app maps the known ones to its screens. */
  href: string;
}

export interface SearchAnswerDto {
  query: string;
  intent: SearchIntent;
  /** One-sentence answer. */
  answer: string;
  cards: SearchCard[];
  links: SearchLink[];
  /** Several vehicles matched the text: pick one (each re-asks with that vehicle). */
  choices?: { objectId: string; label: string; query: string }[];
  /** Not understood / nothing found: example questions to try. */
  examples?: string[];
}

/** Example questions shown in the panel, the guide and when a question isn't understood. */
export const SEARCH_EXAMPLES = [
  'Where is TN 09 BB 9421',
  'Where was TN 09 BB 9421 yesterday at 3 pm',
  'Km TN 09 BB 9421 this week',
  'Most idle this week',
  'Overspeed today',
  'Offline vehicles',
  'Trips TN 09 BB 9421 yesterday',
  'Alerts today',
  'Documents due',
  'Moved last night',
  'Battery low',
  'Charging now',
] as const;
