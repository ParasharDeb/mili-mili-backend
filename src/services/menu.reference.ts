import type { OfferedDish } from "../lib/session.ts";
import type { ReferentKind } from "./menu.route.service.ts";
import { dietAllows } from "./menu.filter.ts";
import { SPICE_MIN_CONFIDENCE } from "../domain/menu.constants.ts";

/**
 * Works out which dish the guest meant.
 *
 * Pure: everything it needs is the message and what was last offered, so every
 * rung is testable without a database or a model.
 *
 * The governing rule is that it never guesses. Adding the wrong dish to an order
 * is discovered at the table, and silently doing nothing leaves a guest thinking
 * it worked -- both are worse than one more question.
 */

export type Resolution =
  | { status: "resolved"; dishes: OfferedDish[] }
  | { status: "ambiguous"; candidates: OfferedDish[]; because: string }
  | { status: "no_context" }
  | { status: "not_on_menu"; term: string };

/** An offer older than this is not what "that one" refers to any more. */
const OFFER_TTL_MS = 15 * 60_000;
const OFFER_MAX_TURNS_AGO = 4;

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, couple: 2,
};

const ORDINAL_WORDS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};

const AFFIRM_RE = /^\s*(yes|yeah|yep|sure|ok|okay|go ahead|do it|order it|sounds good|please)\b/i;

const STOPWORDS = new Set([
  "the", "a", "an", "one", "ones", "that", "this", "those", "these", "it",
  "add", "order", "take", "get", "have", "want", "please", "yes", "yeah", "ok",
  "okay", "sure", "and", "to", "of", "for", "me", "us", "we", "i", "my", "our",
  "remove", "delete", "drop", "cancel", "make", "just", "some", "two", "three",
]);

export function nameKey(name: string): string {
  return name.toLowerCase().replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim();
}

/** Quantity from the message. Never a model's job -- a regex is exact here. */
export function quantityIn(message: string): number {
  const digit = /\b(\d{1,2})\b/.exec(message)?.[1];
  if (digit) return Math.max(1, Math.min(20, Number(digit)));
  const word = Object.keys(NUMBER_WORDS).find((w) => new RegExp(`\\b${w}\\b`, "i").test(message));
  // "one" is far more often "the first one" than a quantity, so it is excluded.
  return word && word !== "one" ? NUMBER_WORDS[word]! : 1;
}

/**
 * Words that describe a dish rather than name it.
 *
 * Excluded from the name-overlap rung, because they collide with real names in
 * the worst possible direction: "the veg one" matched "Tandoori Royal Non Veg
 * Platter" on the token "veg" and handed a vegetarian a meat platter. These are
 * handled by `matchAttribute`, which reads the actual diet field.
 */
const ATTRIBUTE_WORDS = new Set([
  "veg", "vegetarian", "vegan", "non", "nonveg", "jain", "egg", "eggetarian",
  "spicy", "hot", "mild", "bland", "cheap", "cheaper", "cheapest", "expensive",
]);

function tokens(message: string): string[] {
  return message
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !ATTRIBUTE_WORDS.has(w));
}

export function resolve(
  message: string,
  lastOffer: { at: number; turnIndex: number; dishes: OfferedDish[] } | null,
  turnCount: number,
  referentKind: ReferentKind = "unclear",
): Resolution {
  const text = message.toLowerCase();
  const dishes = lastOffer?.dishes ?? [];

  // 1. Staleness. An offer from twenty minutes and four turns ago is not what
  //    "that one" points at -- but a message that names a dish outright does not
  //    need an offer at all, so it skips ahead to rung 8.
  const stale =
    !lastOffer ||
    dishes.length === 0 ||
    Date.now() - lastOffer.at > OFFER_TTL_MS ||
    turnCount - lastOffer.turnIndex > OFFER_MAX_TURNS_AGO;

  if (!stale) {
    // 2. Exact name. nameKey strips parentheticals, so "Glenfiddich 12yrs
    //    (30ml)" is matched by "glenfiddich 12yrs".
    const named = dishes.filter((d) => text.includes(d.nameKey));
    if (named.length === 1) return { status: "resolved", dishes: named };
    if (named.length > 1) {
      return { status: "ambiguous", candidates: named, because: "more than one dish matched that name" };
    }

    // 3. Token overlap, for a distinctive word rather than the whole name.
    const words = tokens(message);
    if (words.length > 0) {
      const scored = dishes
        .map((d) => ({ dish: d, hits: tokens(d.name).filter((t) => words.includes(t)).length }))
        .filter((s) => s.hits > 0)
        .sort((a, b) => b.hits - a.hits);

      if (scored.length === 1) return { status: "resolved", dishes: [scored[0]!.dish] };
      if (scored.length > 1 && scored[0]!.hits > scored[1]!.hits) {
        return { status: "resolved", dishes: [scored[0]!.dish] };
      }
      if (scored.length > 1) {
        return {
          status: "ambiguous",
          candidates: scored.filter((s) => s.hits === scored[0]!.hits).map((s) => s.dish),
          because: "several of those match equally well",
        };
      }
    }

    // 4. Attribute: "the chicken one", "the veg one", "the spicy one".
    const byAttribute = matchAttribute(text, dishes);
    if (byAttribute) {
      if (byAttribute.length === 1) return { status: "resolved", dishes: byAttribute };
      return {
        status: "ambiguous",
        candidates: byAttribute,
        because: "more than one of those fits",
      };
    }

    // 5. Ordinal.
    const ordinal = matchOrdinal(text, dishes.length);
    if (ordinal != null) {
      const dish = dishes[ordinal - 1];
      if (dish) return { status: "resolved", dishes: [dish] };
      return {
        status: "ambiguous",
        candidates: dishes,
        because: `I only offered ${dishes.length}`,
      };
    }

    // 6. Quantifier.
    if (/\b(both|all of (them|it)|everything|all three|the lot)\b/.test(text)) {
      if (/\bboth\b/.test(text) && dishes.length !== 2) {
        return { status: "ambiguous", candidates: dishes, because: "I offered more than two" };
      }
      return { status: "resolved", dishes: dishes.slice(0, 5) };
    }

    // 7. Bare yes. Resolves ONLY when there is exactly one thing it could mean.
    //    This is the most common real ambiguity and the most tempting to guess.
    if (referentKind === "bare_yes" || AFFIRM_RE.test(message)) {
      if (dishes.length === 1) return { status: "resolved", dishes: [dishes[0]!] };
      return {
        status: "ambiguous",
        candidates: dishes,
        because: "I offered a few of those",
      };
    }
  }

  // 8. Nothing matched the offer. The caller falls back to a menu-wide lookup,
  //    which is async and therefore not this function's job.
  const words = tokens(message);
  if (words.length === 0) return { status: "no_context" };
  return { status: "not_on_menu", term: words.join(" ") };
}

function matchOrdinal(text: string, count: number): number | null {
  if (/\blast\b/.test(text)) return count;
  const word = Object.keys(ORDINAL_WORDS).find((w) => new RegExp(`\\b${w}\\b`).test(text));
  if (word) return ORDINAL_WORDS[word]!;
  const suffixed = /\b([1-9])(st|nd|rd|th)\b/.exec(text)?.[1];
  if (suffixed) return Number(suffixed);
  const numbered = /\bnumber\s+([1-9])\b/.exec(text)?.[1];
  return numbered ? Number(numbered) : null;
}

const PROTEIN_WORDS: Record<string, string> = {
  chicken: "Chicken", mutton: "Mutton", lamb: "Mutton", fish: "Fish",
  prawn: "Prawns", prawns: "Prawns", paneer: "Paneer", egg: "Egg", tofu: "Tofu",
};

function matchAttribute(text: string, dishes: OfferedDish[]): OfferedDish[] | null {
  for (const [word, protein] of Object.entries(PROTEIN_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(text)) {
      const hits = dishes.filter((d) => d.protein === protein);
      if (hits.length > 0) return hits;
    }
  }

  if (/\bnon[\s-]*veg\b/.test(text)) {
    const hits = dishes.filter((d) => dietAllows("nonveg", d.diet));
    if (hits.length > 0) return hits;
  } else if (/\bveg(etarian)?\b/.test(text)) {
    const hits = dishes.filter((d) => dietAllows("veg", d.diet));
    if (hits.length > 0) return hits;
  }

  if (/\bspicy|\bhot\b/.test(text)) {
    const hits = dishes.filter(
      (d) => d.spice >= 3 && (d.spiceConfidence ?? 0) >= SPICE_MIN_CONFIDENCE,
    );
    if (hits.length > 0) return hits;
  }

  if (/\bcheap(er|est)?\b/.test(text)) {
    const priced = dishes.filter((d) => d.price != null);
    if (priced.length > 0) {
      const min = Math.min(...priced.map((d) => d.price!));
      return priced.filter((d) => d.price === min);
    }
  }

  return null;
}
