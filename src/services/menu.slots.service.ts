import { env } from "../lib/env.ts";
import { askJev, choice, decided, isTrue, level, noul, score } from "../lib/jev.ts";
import { slotSchema, type Slot, type SlotPlan } from "../schemas/menu.schema.ts";
import type { DrinkStyle } from "../domain/abv.ts";

/**
 * Turns a guest's sentence into slots.
 *
 * The division of labour is deliberate. Splitting the sentence, counting people
 * and reading numbers are regex, because they are exact and a classifier is at
 * its weakest counting and cross-referencing. Every categorical judgement --
 * which diet, which cuisine, which course, how hot -- is Jev, because those are
 * judgements about short spans of text, which is exactly what it is for.
 *
 * Replaces the Mistral JSON parser. Jev cannot emit free text, so `label` and
 * `searchText` are built here from the chunk and the resolved enums.
 */

/* ---------------------------------------------------------------- shared -- */

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, couple: 2,
};

const SPICE_BANDS = ["none", "mild", "medium", "spicy", "very_spicy"] as const;

const NUMBER_TOKEN = `(?:\\d+|${Object.keys(NUMBER_WORDS).join("|")})`;

/**
 * Phrases that state the headcount rather than one person's order: "for 5
 * people", "the 3 of us", "we are four", "table of 6". Captures the number.
 */
const PARTY_RES = [
  new RegExp(`\\bfor\\s+(${NUMBER_TOKEN})\\s*(?:people|pax|guests|persons)\\b`, "g"),
  new RegExp(`\\b(?:the\\s+|all\\s+)?(${NUMBER_TOKEN})\\s+of\\s+us\\b`, "g"),
  new RegExp(`\\bwe\\s*(?:are|'re|r)\\s+(${NUMBER_TOKEN})\\b(?:\\s*(?:people|pax|guests|persons))?`, "g"),
  new RegExp(`\\btable\\s+(?:of|for)\\s+(${NUMBER_TOKEN})\\b`, "g"),
];

function toNumber(token: string): number {
  return Number(token) || NUMBER_WORDS[token] || 0;
}

/** Party size, or 0 when the guest did not say. */
export function partySize(query: string): number {
  const text = query.toLowerCase();
  for (const re of PARTY_RES) {
    re.lastIndex = 0;
    const hit = re.exec(text)?.[1];
    if (hit) return toNumber(hit);
  }
  return 0;
}

/**
 * Splits a request into the parts that each need their own dish.
 *
 * The party-size phrase is stripped first, or "for 5 people. 2 veg" reads the 5
 * as the first chunk's count instead of the 2.
 */
export function splitChunks(query: string): string[] {
  let body = query.toLowerCase();
  for (const re of PARTY_RES) body = body.replace(re, " ; ");

  /**
   * A count opens a new person's order even without punctuation.
   *
   * "1 veg spicy 1 non veg spicy 1 italian" has no comma or "and", so it used to
   * stay one chunk -- the regexes then each fired somewhere in it and produced a
   * single non-veg spicy Italian slot. Once the headcount phrase is gone, two or
   * more counts mean a list, and each count starts an item.
   */
  const countRe = new RegExp(
    `\\b${NUMBER_TOKEN}\\b(?!\\.\\d|\\s*(?:%|percent|per\\s*cent|ml\\b|ltr\\b|yrs?\\b|years?\\b))`,
    "g",
  );
  if ((body.match(countRe) ?? []).length >= 2) {
    body = body.replace(countRe, (n) => `; ${n}`);
  }

  /**
   * "and" only separates constraints when the sentence reads like a list.
   *
   * "2 veg, 1 non veg spicy and 1 jain" is three people. "something spicy and
   * vegetarian" is one dish described twice, and splitting it produced a spicy
   * slot with no diet -- which then returned chicken to someone who had said
   * vegetarian in the same breath. Punctuation or a count is what distinguishes
   * a list from a conjunction, so the split only trusts "and" alongside one.
   */
  const looksLikeList = /[,;]/.test(body) || /\b\d+\b/.test(body) ||
    new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join("|")})\\b`).test(body);

  const separators = looksLikeList
    ? /[,.;:]|\band\b|\bplus\b|&/
    : /[,.;:]|\bplus\b|&/;

  return body
    .split(separators)
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * A number that is a measurement, not a headcount: "15%", "30ml", "12 year old".
 * Stripped before counting, or "a whisky under 40%" orders forty whiskies.
 */
const MEASURE_RE = /\d+(?:\.\d+)?\s*(?:%|percent|per\s*cent|ml\b|ltr\b|l\b|yrs?\b|years?\b|y\b)/g;

function countIn(chunk: string): number {
  const digit = /(\d+)/.exec(chunk.replace(MEASURE_RE, " "))?.[1];
  const word = Object.keys(NUMBER_WORDS).find((w) => new RegExp(`\\b${w}\\b`).test(chunk));
  return Math.max(1, Math.min(50, Number(digit) || NUMBER_WORDS[word ?? ""] || 1));
}

/* ------------------------------------------------------- regex detection -- */

/**
 * Diet from an explicit token. This is not a fallback -- it OUTRANKS Jev.
 *
 * "non veg" and "veg" are unambiguous in a way a probability is not, and the
 * failure it prevents is the one menu.filter.ts opens by warning about. When
 * this returns something, that is the answer.
 */
export function dietFromText(chunk: string): Slot["diet"] | null {
  if (/non[\s-]*veg/.test(chunk)) return "nonveg";
  if (/\bjain\b/.test(chunk)) return "jain";
  if (/\begg/.test(chunk)) return "egg";
  if (/\bfish\b|seafood|pescatarian/.test(chunk)) return "fish";
  if (/\bveg\b|vegetarian|vegan/.test(chunk)) return "veg";
  return null;
}

function spiceFromText(chunk: string): Slot["spice"] | null {
  if (/not\s*spicy|non[\s-]*spicy|no\s*spice|bland|\bmild\b/.test(chunk)) return "none";
  if (/very\s*spicy|extra\s*spicy/.test(chunk)) return "very_spicy";
  if (/spicy|\bhot\b/.test(chunk)) return "spicy";
  return null;
}

const CUISINE_WORDS: Record<string, Slot["cuisine"]> = {
  italian: "Italian", italy: "Italian",
  chinese: "Asian", thai: "Asian", japanese: "Asian", oriental: "Asian", asian: "Asian",
  indian: "Indian", northindian: "Indian", desi: "Indian", punjabi: "Indian",
  continental: "Continental", european: "Continental", western: "Continental",
  american: "Continental",
};

function cuisineFromText(chunk: string): Slot["cuisine"] | null {
  const key = Object.keys(CUISINE_WORDS).find((w) => new RegExp(`\\b${w}\\b`).test(chunk));
  return key ? CUISINE_WORDS[key]! : null;
}

const COURSE_WORDS: Record<string, Slot["course"]> = {
  starter: "Starter", appetiser: "Starter", appetizer: "Starter", snack: "Starter",
  main: "MainCourse", mains: "MainCourse", maincourse: "MainCourse", curry: "MainCourse",
  bread: "Bread", naan: "Bread", roti: "Bread",
  salad: "Salad", dessert: "Dessert", sweet: "Dessert", side: "Sides", sides: "Sides",
  // "drink" on its own is deliberately absent: it means either kind, and
  // mapping it to Beverage is how "alcoholic drinks" came back as Coke.
  beverage: "Beverage",
  shisha: "Shisha", hookah: "Shisha",
};

/**
 * Non-alcoholic is checked FIRST, and wins outright. "Non alcoholic" contains
 * "alcoholic", and a guest who said it must never be handed a cocktail -- this
 * is the drinks equivalent of the diet rule, and is never relaxed either.
 */
const NON_ALCOHOLIC_RE =
  /non[\s-]*alcohol(ic)?|alcohol[\s-]*free|without\s+alcohol|no\s+alcohol|zero[\s-]*proof|\bmocktails?\b|soft\s*drinks?|\bwater\b|\bjuices?\b|\bvirgin\b|\bsodas?\b|milk\s*shakes?|smoothies?|lassi|\b(i|we)\s+(don'?t|do not)\s+drink\b|teetotal/;

const ALCOHOL_RE =
  /\balcohol(ic)?\b|\bbooz(e|y)\b|\bliquor\b|\bspirits?\b|\bhard\s+drinks?\b|\bcocktails?\b|\bshots?\b|whisk(e)?y|scotch|bourbon|single\s*malt|vodka|\bgin\b|\brum\b|tequila|cognac|brandy|\bwines?\b|\bbeers?\b|\bales?\b|lager|prosecco|champagne|sparkling|liqueur|\bpegs?\b|\bdaru\b|sharab|\bbar\b/;

/** "A strong drink" has no alcohol word, but strength only means one thing. */
const STRONG_DRINK_RE =
  /\b(strong|stiff|potent|hard|neat)\b.*\b(drinks?|one|something|glass)\b|\b(drinks?|something)\b.*\b(strong|stiff|potent)\b|\d+\s*(%|percent)/;

export function drinkCourseFromText(chunk: string): "Alcohol" | "Beverage" | null {
  if (NON_ALCOHOLIC_RE.test(chunk)) return "Beverage";
  if (ALCOHOL_RE.test(chunk)) return "Alcohol";
  if (STRONG_DRINK_RE.test(chunk) && DRINK_RE.test(chunk)) return "Alcohol";
  return null;
}

/** Order matters: "whisky cocktail" is a cocktail, "gin and tonic" is gin. */
const STYLE_WORDS: [RegExp, DrinkStyle][] = [
  [/\bcocktails?\b|martini|mojito|margarita|old\s*fashioned|negroni|highball|long\s*island/, "cocktail"],
  [/\bshots?\b|shooters?/, "shot"],
  [/\bbeers?\b|\bales?\b|lager|pilsner|weizen|stout|\bipa\b|pint/, "beer"],
  [/\bwines?\b|prosecco|champagne|sparkling|bubbly|\brose\b|ros[eé]|\bred\b|\bwhite\b|shiraz|merlot|chardonnay|pinot/, "wine"],
  [/liqueurs?|baileys|kahlua|jager|sambuca/, "liqueur"],
  [/whisk(e)?y|scotch|bourbon|single\s*malt|\bmalt\b/, "whisky"],
  [/vodka/, "vodka"],
  [/\bgin\b/, "gin"],
  [/\brum\b/, "rum"],
  [/tequila|mezcal/, "tequila"],
  [/brandy|cognac/, "brandy"],
  [/\bspirits?\b|\bliquor\b|\bpegs?\b|hard\s+drinks?/, "spirit"],
];

export function drinkStyleFromText(chunk: string): DrinkStyle | undefined {
  return STYLE_WORDS.find(([re]) => re.test(chunk))?.[1];
}

/**
 * Strength of a drink, in words or as a percentage.
 *
 * Negated forms are checked before the plain word, or "not too strong" reads as
 * strong. Numbers are % ABV only when they carry a % or "percent" -- a bare
 * number in a chunk is a headcount.
 */
export function strengthFromText(chunk: string): Pick<Slot, "strength" | "abvMin" | "abvMax"> {
  const pct = `(\\d+(?:\\.\\d+)?)\\s*(?:%|percent|per\\s*cent)`;
  const upper = new RegExp(`(?:under|below|less\\s+than|up\\s*to|upto|max(?:imum)?|at\\s+most|<)\\s*${pct}`).exec(chunk);
  const lower = new RegExp(`(?:over|above|more\\s+than|at\\s+least|min(?:imum)?|>)\\s*${pct}`).exec(chunk)
    ?? new RegExp(`${pct}\\s*(?:\\+|or\\s+more|and\\s+above|plus)`).exec(chunk);

  if (upper || lower) {
    return {
      strength: "any",
      ...(lower ? { abvMin: Number(lower[1]) } : {}),
      ...(upper ? { abvMax: Number(upper[1]) } : {}),
    };
  }

  const exact = new RegExp(pct).exec(chunk);
  if (exact) {
    const n = Number(exact[1]);
    return { strength: "any", abvMin: Math.max(0, n - 5), abvMax: Math.min(100, n + 5) };
  }

  if (/not\s+(too\s+|very\s+|that\s+)?(strong|hard|heavy|potent)|low[\s-]*(abv|alcohol|proof)|\blight\b|\bmild\b|\beasy\b|\bweak\b|session/.test(chunk)) {
    return { strength: "light" };
  }
  if (/\bstrong\b|\bstiff\b|\bpotent\b|\bhard\b|high[\s-]*(abv|alcohol|proof)|\bneat\b|\bheavy\b|\bkick\b|knock\s+(me|us)\s+out/.test(chunk)) {
    return { strength: "strong" };
  }
  if (/\bmedium\b|\bmoderate\b/.test(chunk)) return { strength: "medium" };
  return { strength: "any" };
}

function courseFromText(chunk: string): Slot["course"] | null {
  const drink = drinkCourseFromText(chunk);
  if (drink) return drink;
  // Optional plural: "2 desserts", "starters", "sandwiches".
  const key = Object.keys(COURSE_WORDS).find((w) => new RegExp(`\\b${w}(?:e?s)?\\b`).test(chunk));
  return key ? COURSE_WORDS[key]! : null;
}

const DRINK_RE =
  /cocktail|drink|wine|beer|mocktail|juice|shisha|hookah|whisk(e)?y|vodka|\brum\b|\bgin\b|tequila|alcohol|booz|liquor|spirit|\bshots?\b|beverage/;

/* ---------------------------------------------------------- label / text -- */

const DIET_LABELS: Record<string, string> = {
  veg: "vegetarian", nonveg: "non-veg", egg: "eggetarian",
  fish: "seafood", jain: "Jain",
};

/** Jev cannot write prose, so the label a guest sees is assembled from the facts. */
export function buildLabel(slot: Omit<Slot, "label" | "searchText">): string {
  const bits = [
    String(slot.count),
    DIET_LABELS[slot.diet] ?? "",
    slot.spice === "none" ? "mild" : slot.spice !== "any" ? slot.spice.replace("_", " ") : "",
    slot.cuisine !== "any" ? slot.cuisine : "",
    slot.strength && slot.strength !== "any" ? slot.strength : "",
    slot.abvMin != null && slot.abvMax != null
      ? `${slot.abvMin}-${slot.abvMax}%`
      : slot.abvMin != null ? `${slot.abvMin}%+` : slot.abvMax != null ? `under ${slot.abvMax}%` : "",
    slot.course === "Alcohol"
      ? slot.drinkStyle ?? "alcoholic drink"
      : slot.course === "Beverage"
        ? "non-alcoholic drink"
        : slot.course !== "any" ? slot.course.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase() : "",
  ].filter(Boolean);
  return bits.join(" ").trim() || "Anything";
}

const CHUNK_NOISE =
  /\b(i|we|me|my|our|want|need|would|like|get|have|give|us|some|a|an|the|please|for|with|and|of|to|is|are|something|anything|order|recommend|suggest|people|pax|guests|persons|table|alcoholic|alcohol|non|drinks?|beverages?|booze|boozy|percent|abv)\b/g;

/** Strength words describe % ABV, which the ranker scores directly -- not text to match. */
const STRENGTH_NOISE =
  /\b(strong|light|mild|stiff|hard|very|too|not|medium|moderate|kick|potent|low|high|under|over|above|below|less|more|than|least|most|neat|heavy|easy|weak)\b/g;

/**
 * The keyword hint the SQL ranker matches on.
 *
 * This used to be an embedding probe -- a sentence written for a vector. It is
 * now fed to trigram and full-text matching, so it keeps the guest's actual
 * vocabulary ("wontons", "biryani") which the enums cannot carry, and appends
 * the resolved constraints for the dishes whose names state them.
 */
export function buildSearchText(chunk: string, slot: Omit<Slot, "label" | "searchText">): string {
  const words = chunk
    .replace(/\d+/g, " ")
    .replace(CHUNK_NOISE, " ")
    .replace(slot.course === "Alcohol" ? STRENGTH_NOISE : /$^/, " ")
    .replace(/[^a-z0-9\s]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);

  const extra = [
    slot.cuisine !== "any" ? slot.cuisine : "",
    slot.spice === "spicy" || slot.spice === "very_spicy" ? "spicy" : "",
  ].filter(Boolean);

  const text = [...new Set([...words, ...extra])].join(" ").trim();
  return (text || "popular dish").slice(0, 160);
}

/* -------------------------------------------------------- Jev definitions -- */

export const CHUNK_QUESTIONS = {
  diet: choice(
    "This is one part of a restaurant guest's request. What kind of diet must the dish in THIS part suit? Answer 'any' unless this part actually says.",
    {
      veg: "Vegetarian -- no meat, no fish, no egg.",
      nonveg:
        "Non-vegetarian -- the guest WANTS meat: chicken, mutton, lamb, or a dish built around meat. 'Non-veg' means they are asking for meat, not merely tolerating it.",
      egg: "Eggetarian -- vegetarian, but egg is welcome. Only when egg is mentioned specifically.",
      fish: "Seafood or pescatarian -- fish or prawns specifically, and no other meat.",
      jain: "Jain -- vegetarian and additionally without onion, garlic or root vegetables.",
      any: "This part says nothing about which diet the dish has to suit.",
    },
  ),
  cuisine: choice(
    "This is one part of a restaurant guest's request. Which cuisine does THIS part ask for? Answer 'any' unless a cuisine is named or unmistakably implied by a dish style.",
    {
      Indian: "Indian -- north Indian, south Indian, Mughlai, Punjabi, desi, tandoori, curry, biryani.",
      Asian: "East or South-East Asian -- Chinese, Thai, Japanese, Korean, pan-Asian, sushi, ramen, dim sum, noodles as a style.",
      Italian: "Italian -- pasta, pizza, risotto, lasagne, or the word Italian.",
      Continental: "European or American -- grills, steaks, burgers, sandwiches, roasts, or the words continental or western.",
      Other: "A cuisine that is named but is none of the above, such as Mexican, Lebanese or Middle Eastern.",
      any: "This part does not name or imply a cuisine.",
    },
  ),
  course: choice(
    "This is one part of a restaurant guest's request. Which course of the meal does THIS part ask for? Answer 'any' unless this part says.",
    {
      Starter: "A first plate -- appetiser, snack, small plate, something to nibble before the mains.",
      MainCourse: "A main dish -- a curry, a biryani, a large plate meant as the centre of the meal.",
      Bread: "Bread from the tandoor or the pan -- roti, naan, kulcha, paratha.",
      Salad: "A salad.",
      Sides: "A side or accompaniment -- raita, papad, fries, chutney.",
      Dessert: "Something sweet to finish -- dessert, pudding, ice cream, mithai, cake.",
      Beverage: "A non-alcoholic drink -- juice, soda, mocktail, tea, coffee, lassi, water.",
      Alcohol: "An alcoholic drink -- cocktail, beer, wine, whisky, spirits.",
      Shisha: "Shisha or hookah.",
      any: "This part does not say which course it is about.",
    },
  ),
  mentions_spice: noul(
    "This part of the guest's request says something about how hot or mild they want the food to be.",
  ),
  spice: score(
    "How hot does the guest want the dish in THIS part of the request to be? Judge only what the guest asked for, never what the dish is usually like.",
    [
      "No heat at all -- 'not spicy', 'no chilli', 'bland'.",
      "Gentle heat -- 'mild', 'light on the spice'.",
      "Everyday, moderate heat -- 'medium', 'normal spice'.",
      "Hot -- 'spicy', 'give it some kick'.",
      "As hot as the kitchen will make it -- 'very spicy', 'extra hot'.",
    ],
  ),
  is_drink: noul(
    "This part of the guest's request is about something to drink, or about shisha -- not about food.",
  ),
} as const;

/* ------------------------------------------------------------ assembling -- */

type ChunkAnswers = Partial<{
  [K in keyof typeof CHUNK_QUESTIONS]: any;
}>;

/**
 * Combines one chunk's regex reading with Jev's, and builds the slot.
 *
 * The confidence policy is asymmetric on purpose. For cuisine, course and spice,
 * an unconfident answer falls back to "any", which WIDENS the search -- a guest
 * who said "Italian" and gets a broader set is mildly disappointed. Diet does
 * not work that way: "any" is wider than "veg", so a shaky `veg` would hide the
 * food they wanted and a shaky `nonveg` would do something worse. So the regex
 * wins outright where it fires, Jev needs a higher bar, and when the two
 * disagree the narrower reading is taken.
 */
export function assembleSlot(chunk: string, answers: ChunkAnswers | null): Slot | null {
  const count = countIn(chunk);

  const regexDiet = dietFromText(chunk);
  const jevDiet = answers
    ? decided<Slot["diet"]>(answers.diet, "any", env.JEV_DIET_MIN_CONFIDENCE)
    : "any";

  let diet: Slot["diet"] = regexDiet ?? jevDiet;
  if (regexDiet && answers && jevDiet !== "any" && jevDiet !== regexDiet) {
    // Narrower wins. `nonveg` is the narrowest reading there is -- it is the
    // only diet token that asks FOR something rather than excluding it.
    const narrower: Slot["diet"][] = ["jain", "nonveg", "fish", "egg", "veg", "any"];
    diet = narrower.indexOf(jevDiet) < narrower.indexOf(regexDiet) ? jevDiet : regexDiet;
    console.warn(
      `[slots] diet disagreement on "${chunk}": regex=${regexDiet} jev=${jevDiet}, taking ${diet}`,
    );
  }

  // `score` has no "any" level -- "unstated" is not a point on a heat axis --
  // so it is gated behind a noul that asks whether heat was mentioned at all.
  const regexSpice = spiceFromText(chunk);
  let spice: Slot["spice"] = regexSpice ?? "any";
  if (!regexSpice && answers && isTrue(answers.mentions_spice)) {
    const band = level(answers.spice);
    if (band != null) spice = SPICE_BANDS[Math.max(0, Math.min(4, band))]!;
  }

  const cuisine = cuisineFromText(chunk)
    ?? (answers ? decided<Slot["cuisine"]>(answers.cuisine, "any") : "any");

  const course = courseFromText(chunk)
    ?? (answers ? decided<Slot["course"]>(answers.course, "any") : "any");

  const isDrink =
    DRINK_RE.test(chunk) ||
    (answers ? isTrue(answers.is_drink) : false) ||
    ["Beverage", "Alcohol", "Shisha"].includes(course);

  // For the bar, "mild", "light" and "a kick" are about alcohol, not chilli --
  // and every bar item is stored at heat 0, so a spice filter would empty it.
  // Strength only applies when the guest asked for alcohol; a vague "a light
  // drink" says nothing about %.
  let strength: Pick<Slot, "strength" | "abvMin" | "abvMax" | "drinkStyle"> = {};
  if (course === "Alcohol") {
    spice = "any";
    const drinkStyle = drinkStyleFromText(chunk);
    strength = { ...strengthFromText(chunk), ...(drinkStyle ? { drinkStyle } : {}) };
  }

  // A chunk that states nothing ("i need recommendations") is not a slot.
  if (diet === "any" && spice === "any" && cuisine === "any" && course === "any" && !isDrink) {
    return null;
  }

  const partial = {
    count,
    diet,
    spice,
    cuisine,
    course,
    courseGroup: (isDrink ? "drink" : "food") as Slot["courseGroup"],
    ...strength,
  };

  const parsed = slotSchema.safeParse({
    ...partial,
    label: buildLabel(partial),
    searchText: buildSearchText(chunk, partial),
  });

  return parsed.success ? parsed.data : null;
}

export type SlotResult = { plan: SlotPlan; mode: "jev" | "heuristic" };

/**
 * Breaks the request into its parts and resolves each one.
 *
 * Every chunk gets its own Jev call, fired in parallel. The alternative -- one
 * call with questions namespaced per chunk -- would save round trips, but every
 * question would then see the whole message and have to be told "consider only
 * part 3", which is precisely the cross-referencing Jev is weakest at. It would
 * also mean the criteria strings shipped are templated rather than the ones
 * tested. Input tokens are the only cost of fanning out, and they are tiny.
 */
export async function planSlots(
  query: string,
  opts: { preAnswers?: ChunkAnswers | null; multi?: boolean } = {},
): Promise<SlotResult> {
  const chunks = splitChunks(query).slice(0, env.RECO_MAX_SLOTS);
  const size = partySize(query);

  // Single-constraint requests reuse the routing call's answers, so the common
  // case costs exactly one Jev round trip for the whole turn.
  if (opts.multi === false && opts.preAnswers && chunks.length <= 1) {
    const slot = assembleSlot(chunks[0] ?? query.toLowerCase(), opts.preAnswers);
    return {
      plan: { partySize: size, slots: slot ? [slot] : [] },
      mode: "jev",
    };
  }

  const answers = await Promise.all(chunks.map((chunk) => askJev(chunk, CHUNK_QUESTIONS)));
  const usedJev = answers.some((a) => a !== null);

  const slots = chunks
    .map((chunk, i) => assembleSlot(chunk, answers[i] ?? null))
    .filter((s): s is Slot => s !== null);

  return { plan: { partySize: size, slots }, mode: usedJev ? "jev" : "heuristic" };
}

/**
 * Regex-only planning. Used when Jev is unconfigured or its breaker is open,
 * and as the offline test oracle for the filter mapping.
 *
 * It is pure CPU and cannot fail, which is why it is the last resort rather than
 * a second network call: a network problem usually takes every provider with it.
 */
export function heuristicPlan(query: string): SlotPlan {
  const slots = splitChunks(query)
    .slice(0, env.RECO_MAX_SLOTS)
    .map((chunk) => assembleSlot(chunk, null))
    .filter((s): s is Slot => s !== null);

  return { partySize: partySize(query), slots };
}

/** A single unconstrained slot, for "what should we order for four?". */
export function fallbackSlot(count: number): Slot {
  const partial = {
    count: Math.max(1, Math.min(50, count || 1)),
    diet: "any" as const,
    spice: "any" as const,
    cuisine: "any" as const,
    course: "any" as const,
    courseGroup: "food" as const,
  };
  return {
    ...partial,
    label: count > 1 ? `${count} guests` : "Something good",
    searchText: count > 1 ? "popular dish to share" : "popular dish",
  };
}
