/**
 * Regex readings of a guest message for the concierge paths.
 *
 * These are the fallback when Jev is down, and -- for hard stops only -- a
 * safety net that runs even when Jev is up. A missed hard stop leaves a guest
 * with food poisoning talking to a menu bot; a false one brings a manager to a
 * table that did not need one. The second is the cheap mistake, so the hard-stop
 * patterns are deliberately broad and the topic patterns deliberately narrow.
 */

export type HardStopCategory =
  | "illness"
  | "allergic_reaction"
  | "foreign_object"
  | "injury"
  | "staff_conduct"
  | "bill_dispute"
  | "legal_or_media"
  | "persistent_anger"
  | "unspecified";

export type ConciergeTopic =
  | "none"
  | "issue"
  | "call_manager"
  | "call_captain"
  | "reservation"
  | "music_request"
  | "feedback"
  | "occasion"
  | "waiting_for_friends"
  | "farewell";

const FOREIGN =
  "hair|glass|plastic|metal|stone|pebble|insect|bug|cockroach|roach|fly|worm|maggot|nail|staple|thread|wire";

const HARD_STOPS: [HardStopCategory, RegExp][] = [
  [
    "illness",
    /\b(food poisoning|poison(ed|ing)?|(feel(ing)?|felt|got|am|i'?m|getting) (really |very |so )?(sick|ill|nauseous|unwell|queasy)|vomit(ed|ing)?|threw up|throwing up|stomach (ache|pain|cramps?|upset)|upset stomach|diarrh?o?ea|loose motions?)\b/i,
  ],
  [
    "allergic_reaction",
    /\b(allergic reaction|(having|had|got) an? (allergy|allergic)|anaphyla\w*|epi-?pen|can'?t breathe|trouble breathing|(throat|lips?|tongue|face) (is |are )?(swelling|swollen|closing|itching|tingling)|swollen (lips?|tongue|throat|face)|hives)\b/i,
  ],
  [
    "foreign_object",
    new RegExp(
      `\\b(${FOREIGN})s?\\b.{0,30}\\b(in|inside|on)\\b.{0,12}\\b(food|dish|plate|curry|drink|biryani|soup|salad|naan|bowl|rice|dal|gravy|starter|dessert|cocktail|mocktail)\\b` +
        `|\\bfound (a|an|some)\\b.{0,20}\\b(${FOREIGN})s?\\b`,
      "i",
    ),
  ],
  [
    "injury",
    /\b(injur(ed|y)|hurt (myself|herself|himself|my|his|her)|(cut|burn(ed|t)?) (myself|my (hand|finger|mouth|tongue|lip))|slipped|fell (down|over|off)|bleeding|broke (my|a) tooth|chipped (a |my )?tooth|broken tooth)\b/i,
  ],
  [
    "staff_conduct",
    /\b(waiter|captain|staff|server|manager|bartender|bouncer|guard|steward|he|she|they)\b.{0,40}\b(was |is |were |are )?(rude|abusive|harass\w*|touched me|misbehav\w*|shouted at|yelled at|insulted|racist|sexist|drunk|stole|inappropriate)\b|\b(rude|abusive|drunk)\s+(waiter|staff|captain|server|manager|bartender|bouncer)\b/i,
  ],
  [
    "bill_dispute",
    /\b(overcharg\w*|wrong(ly)? (bill|charged?)|bill (is )?wrong|charged (me |us )?(twice|extra|double|for something)|double charged|dispute|not paying|won'?t pay|refuse to pay|refund|hidden charges?)\b/i,
  ],
  [
    "legal_or_media",
    /\b(police|cops?|lawyer|advocate|legal action|sue|suing|consumer (court|forum)|journalist|reporter|going viral|posting (this|it)|(post|put|write) (this|it|about (this|you)) (on|online)|i'?m posting|bad review|(one|1)[- ]star review|expose you)\b/i,
  ],
];

const ANGER_RE =
  /\b(disgusting|pathetic|worst|terrible|horrible|awful|unacceptable|ridiculous|shameful|furious|angry|livid|fed up|waste of (money|time)|never coming back|what the (hell|f\w*)|wtf|f+u+c+k\w*|shit\w*|bullshit|bloody)\b|!{3,}/i;

export function detectHardStop(message: string): HardStopCategory | null {
  for (const [category, re] of HARD_STOPS) {
    if (re.test(message)) return category;
  }
  return null;
}

export function detectAnger(message: string): boolean {
  if (ANGER_RE.test(message)) return true;
  // A shouted message: mostly capitals and long enough not to be "OK" or "BBQ".
  const letters = message.replace(/[^a-z]/gi, "");
  return letters.length >= 12 && letters === letters.toUpperCase();
}

/* ---------------------------------------------------------------- topics -- */

const WAITING_RE =
  /\b(waiting|wait) (for|on) (my |the |our |a )?(friends?|others|people|family|someone|somebody|group|rest|wife|husband|partner|date|colleagues?|guests?|boss)\b|\b(my |our )?(friends?|others|rest of us|family) (are|is) (on (the|their) way|running late|coming|late)\b/i;

const ISSUE_RE =
  /\b(too (loud|cold|hot|noisy|dark|bright|slow|smoky|crowded)|(ac|a\/c|air ?con\w*|fan|light|lights|music|speaker)\b.{0,20}\b(too|not working|isn'?t working|broken|off)\b|(table|glass|plate|cutlery|fork|spoon|knife|chair|washroom|toilet|restroom|bathroom|loo|seat)\b.{0,25}\b(dirty|wet|sticky|broken|wobbl\w*|smell\w*|stinks?|no (water|soap|tissues?|paper)|out of \w+|not clean|unclean|filthy|blocked|flooded)\b|\b(dirty|wet|sticky|wobbly|broken)\s+(table|glass|plate|cutlery|fork|spoon|chair|seat)|(still )?waiting (for|since)\b.{0,30}\b(food|order|drinks?|dish|ages|long|minutes|an hour|hour)|(taking|taken|takes) (too|so|really) long|(food|dish|it) is (cold|stale|raw|undercooked|burnt|off)|cold food|(wrong|not what i) (dish|order|ordered|item)|nobody (has )?(come|came|attended)|no one (has )?(come|came|attended)|(?<!no )complain\w*|not happy|unhappy)\b/i;

const MANAGER_RE =
  /\b(call|get|send|want|need|speak (to|with)|talk (to|with)|see|bring)\b.{0,20}\bmanager\b|\bmanager\b.{0,15}\b(please|here|over|now)\b/i;
const CAPTAIN_RE =
  /\b(call|get|send|need|want|bring)\b.{0,15}\b(the |my |our |a )?(captain|waiter|server|steward|someone|somebody|staff)\b(?!.{0,20}\b(recommend|suggest)\b)/i;
const RESERVATION_RE =
  /\b(book(ing)?|reserv(e|ation|ations))\b.{0,30}\b(table|for|on|tomorrow|tonight|today|next|this|mon|tue|wed|thu|fri|sat|sun|\d)|\b(book|reserve) (a|us a|me a) table\b|\breservation\b/i;
const HAVE_BOOKING_RE = /\b(i|we) (have|had|made|booked) (a |the )?(reservation|booking|table)\b/i;
const MUSIC_RE =
  /\b(can you|could you|would you|please|pls|plz|ask (them|the dj) to)?\s*(play|put on)\b.{0,40}\b(song|track|music|by|some|something)\b|\b(song|track) request\b|\brequest (a )?(song|track)\b|\bdj\b.{0,25}\bplay\b/i;
const FEEDBACK_RE =
  /\b(feedback|give (you )?(a |some )?(review|rating)|rate (you|the|this|us|my)|leave (a )?review|want to review)\b/i;
const OCCASION_RE =
  /\b(it'?s|its|it is|my|our|his|her|their|wife'?s|husband'?s|friend'?s|we'?re celebrating|celebrating)\b.{0,20}\b(birthday|b'?day|bday|anniversary)\b|\b(birthday|anniversary)\b.{0,15}\b(today|tonight|dinner|celebration)\b/i;
const FAREWELL_RE =
  /^\W*(bye|goodbye|good ?night|see (you|ya)|cheers)\b|\b(we'?re|we are|i'?m|i am) (leaving|off|heading (out|home)|done for (the night|tonight))\b|\bthanks? (you )?for (everything|tonight|the evening|a lovely (evening|night|dinner))\b/i;

/**
 * Most specific first. "The waiter was rude, get the manager" must not stop at
 * the manager -- but that is a hard stop, handled before any topic is read.
 * "Still waiting for our food" is an issue, not "waiting for friends", so issue
 * comes before waiting only for the food case the ISSUE_RE itself spells out.
 */
export function detectTopic(message: string): ConciergeTopic {
  if (MANAGER_RE.test(message)) return "call_manager";
  if (ISSUE_RE.test(message)) return "issue";
  if (WAITING_RE.test(message)) return "waiting_for_friends";
  // "We have a reservation under Sen" is arriving, not booking.
  if (RESERVATION_RE.test(message) && !HAVE_BOOKING_RE.test(message)) return "reservation";
  if (MUSIC_RE.test(message)) return "music_request";
  if (CAPTAIN_RE.test(message)) return "call_captain";
  if (FEEDBACK_RE.test(message)) return "feedback";
  if (OCCASION_RE.test(message)) return "occasion";
  if (FAREWELL_RE.test(message)) return "farewell";
  return "none";
}

export function occasionKind(message: string): "birthday" | "anniversary" | "other" {
  if (/\b(birthday|b'?day|bday)\b/i.test(message)) return "birthday";
  if (/\banniversary\b/i.test(message)) return "anniversary";
  return "other";
}

/* ----------------------------------------------------------- reservation -- */

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
};
const NUM = `(\\d{1,2}|${Object.keys(NUMBER_WORDS).join("|")})`;

const DAY = "(mon|tues|wednes|thurs|fri|satur|sun)day";
const MONTH = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";
const DATE_RE = new RegExp(
  `\\b(day after tomorrow|today|tonight|tomorrow|this (weekend|${DAY})|next (week|weekend|${DAY})|${DAY}` +
    `|\\d{1,2}(st|nd|rd|th)?( of)? ${MONTH}|${MONTH} \\d{1,2}(st|nd|rd|th)?|\\d{1,2}[/.-]\\d{1,2}([/.-]\\d{2,4})?)\\b`,
  "i",
);
const TIME_RE =
  /\b(\d{1,2}([:.]\d{2})?\s*(am|pm|o'?clock)|\d{1,2}:\d{2}|(at|around|by|about) \d{1,2}([:.]\d{2})?|noon|midnight|lunch(time)?|dinner(time)?|evening|afternoon)\b/i;
const PARTY_RE = new RegExp(
  `\\b(?:for|party of|table for|we'?re|we are|group of)\\s+${NUM}\\b(?!\\s*(am|pm|:|o'?clock|th|st|nd|rd))` +
    `|\\b${NUM}\\s+(people|persons|pax|guests|of us|adults|heads)\\b`,
  "i",
);

function toNumber(raw: string): number | null {
  const n = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw.toLowerCase()];
  return n && n > 0 && n <= 50 ? n : null;
}

export type ReservationField = "date" | "time" | "partySize";

/**
 * Reads whatever the message says about a booking.
 *
 * Kept as text, never parsed into a Date: the desk confirms every request by
 * hand, and "Saturday around 9" is exactly what they need to read. A parser
 * would only add a way to be wrong about which Saturday.
 *
 * `expecting` is the field the assistant just asked for, so a bare "4" or "9"
 * in reply can be read as that field and nothing else.
 */
export function parseReservation(
  message: string,
  expecting?: ReservationField,
): { dateText: string | null; timeText: string | null; partySize: number | null } {
  const date = DATE_RE.exec(message)?.[0] ?? null;
  const time = TIME_RE.exec(message)?.[0] ?? null;

  const party = PARTY_RE.exec(message);
  let partySize = party ? toNumber((party[1] ?? party[3])!) : null;

  const bare = new RegExp(`^\\s*${NUM}\\s*\\W*$`, "i").exec(message)?.[1];
  let timeText = time;
  if (bare && expecting === "partySize" && partySize == null) partySize = toNumber(bare);
  if (bare && expecting === "time" && timeText == null) timeText = bare;

  return { dateText: date, timeText, partySize };
}
