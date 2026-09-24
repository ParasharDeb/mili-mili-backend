import { env, isChatConfigured } from "../lib/env.ts";
import { chatJson } from "../lib/mistral.ts";
import { SPICE_MIN_CONFIDENCE } from "../domain/menu.constants.ts";
import { dietAllows } from "./menu.filter.ts";
import { getMenuForAdvice } from "./menu.sql.service.ts";
import type { PublicItem } from "./menu.items.service.ts";

/**
 * The judgement path: "suggest a good combo for non-veg", "what's good here".
 *
 * These are not filters -- there is no WHERE clause for "good" -- so the whole
 * eligible menu goes to the model and it composes. The food menu is about 80
 * dishes, roughly 1.5k tokens rendered, so it fits whole with room to spare.
 *
 * A SQL pre-filter still runs whenever the guest stated a diet. Not for the
 * token budget: filtering first makes it structurally impossible for the model
 * to answer "a good non-veg combo" with paneer, which is the same argument
 * menu.filter.ts makes for never relaxing a diet constraint -- encode the
 * promise in the query rather than asking a model to keep it.
 */

const SYSTEM_PROMPT = `You are the pass at Milli, a restaurant. A guest has asked for your judgement rather than a filter.

You will be given tonight's menu as numbered lines: ref|name|diet|cuisine|course|heat|price|tastes.
Diet is V (vegetarian), NV (non-vegetarian), E (egg), F (seafood), J (jain).
Heat is h0 to h5, or h? when the kitchen never recorded it.

Return JSON only:
{"answer":"<2-4 sentences>","picks":[{"ref":<number from the list>,"role":"<Starter|Main|Bread|Side|Dessert|Drink>","why":"<max 12 words>"}]}

Rules:
- Every dish you pick MUST be one of the numbered lines. Use its ref. Never invent a
  dish, a price, an ingredient or an allergen, and never pick a ref that is not listed.
- In your prose, name dishes using their EXACT name from the list, spelled the same way.
- Pick 3 to 5 dishes. Prefer a spread across courses so it reads as a meal, not a list.
- Where a dish shows h?, do not state a heat level -- say it is not recorded.
- Be warm and brief: 2 to 4 sentences, no headings, no bullet lists.
- If the list cannot answer what was asked, say so plainly and pick nothing.`;

const DIET_SHORT: Record<string, string> = {
  Vegetarian: "V",
  NonVegetarian: "NV",
  Eggetarian: "E",
  OnlyFish: "F",
  Jain: "J",
};

/**
 * One line per dish, keyed by a per-request ordinal.
 *
 * Deliberately not the uuid: 435 uuids is ~4.4k tokens of pure identifier, more
 * than the menu itself, and a model that half-remembers one produces a
 * plausible-looking id that does not exist. A small integer it cannot misremember
 * into something real.
 */
export function render(items: PublicItem[]): { listing: string; refs: Map<number, PublicItem> } {
  const refs = new Map<number, PublicItem>();
  const lines: string[] = [];

  items.forEach((item, i) => {
    const ref = i + 1;
    refs.set(ref, item);
    const heat =
      item.spiceConfidence != null && item.spiceConfidence >= SPICE_MIN_CONFIDENCE
        ? `h${item.spice}`
        : "h?";
    lines.push(
      [
        ref,
        item.name,
        DIET_SHORT[item.diet] ?? item.diet,
        item.cuisine,
        item.course,
        heat,
        item.price != null ? Math.round(item.price) : "",
        item.course === "Alcohol" && item.abv != null
          ? [`~${item.abv}%`, ...item.tasteTags].join(",")
          : item.tasteTags.join(","),
      ].join("|"),
    );
  });

  return { listing: lines.join("\n"), refs };
}

/** Capitalised runs of two or more words -- what a dish name looks like in prose. */
export function candidateNames(prose: string): string[] {
  return prose.match(/\b[A-Z][a-z]+(?:\s+(?:[A-Z][a-z]+|&|and|with|of))*\s+[A-Z][a-z]+\b/g) ?? [];
}

export const IGNORE_PHRASES = new Set(["i would", "you might", "if you", "for you", "the kitchen"]);

export type AdviceResult = {
  answer: string;
  picks: { item: PublicItem; role: string; why: string }[];
  warnings: { code: string; message: string }[];
  degraded: boolean;
};

export async function advise(
  question: string,
  opts: { diet?: string; includeDrinks?: boolean } = {},
): Promise<AdviceResult> {
  const menu = await getMenuForAdvice({
    diet: opts.diet,
    includeDrinks: opts.includeDrinks,
    limit: env.ADVISE_MAX_ITEMS,
  });

  if (menu.length === 0) {
    return {
      answer: "I cannot see anything on tonight's menu that fits that.",
      picks: [],
      warnings: [{ code: "ADVICE_NO_MENU", message: "No dishes matched the stated constraints." }],
      degraded: false,
    };
  }

  if (!isChatConfigured) {
    return degrade(menu, "Set MISTRAL_API_KEY to get a written suggestion.");
  }

  const { listing, refs } = render(menu);
  const warnings: AdviceResult["warnings"] = [];

  let raw: any;
  try {
    raw = await chatJson(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Tonight's menu:\n${listing}\n\nGuest asks: ${question}` },
      ],
      { maxTokens: 700, timeoutMs: 20_000 },
    );
  } catch (err) {
    console.warn(`[advise] model unavailable: ${err instanceof Error ? err.message : err}`);
    return degrade(menu, "The kitchen's notes are not loading, so here is what fits.");
  }

  // Hard gate: a ref that is not on the list we sent never becomes a card.
  const picks: AdviceResult["picks"] = [];
  const seen = new Set<string>();
  let dropped = 0;

  for (const pick of Array.isArray(raw?.picks) ? raw.picks : []) {
    const item = refs.get(Number(pick?.ref));
    if (!item || seen.has(item.id)) {
      dropped++;
      continue;
    }
    // Re-verify the promise, exactly as the recommendation path does. Here it
    // matters most: the model chose these, not a WHERE clause.
    if (opts.diet && opts.diet !== "any" && !dietAllows(opts.diet, item.diet)) {
      console.warn(`[advise] model picked ${item.name} (${item.diet}) for a '${opts.diet}' request`);
      dropped++;
      continue;
    }
    seen.add(item.id);
    picks.push({
      item,
      role: String(pick?.role ?? item.course).slice(0, 20),
      why: String(pick?.why ?? "").slice(0, 80),
    });
    if (picks.length >= 5) break;
  }

  if (dropped > 0) {
    warnings.push({
      code: "ADVICE_REF_DROPPED",
      message: `${dropped} suggestion(s) did not match a dish on the menu and were dropped.`,
    });
  }

  if (picks.length === 0) {
    return degrade(menu, "Here is what fits, straight from tonight's menu.");
  }

  // The prose and the refs are produced in the same JSON but are not guaranteed
  // to agree, and validating the refs does not cover the sentence. Two failures
  // matter equally to a guest: a dish that does not exist, and a dish that does
  // exist but is not one of the cards shown beside the text. Both are checked
  // against the PICKS, not the menu -- the model once recommended "Chicken Tikka
  // Kebab" in prose while carding "Chicken Lehsuni Kebab", and both are real.
  let answer = String(raw?.answer ?? "").trim();
  const picked = picks.map((p) => p.item.name.toLowerCase());
  const mismatched = candidateNames(answer).filter((name) => {
    const n = name.toLowerCase();
    if (IGNORE_PHRASES.has(n) || n.length < 6) return false;
    return !picked.some((k) => k.includes(n) || n.includes(k));
  });

  if (!answer || mismatched.length > 0) {
    if (mismatched.length > 0) {
      console.warn(`[advise] prose named dishes it did not pick: ${mismatched.join(", ")}`);
      warnings.push({
        code: "ADVICE_PROSE_REPLACED",
        message: "The written suggestion named a dish that was not among the ones shown, so it was rewritten.",
      });
    }
    answer = sentenceFor(picks.map((p) => p.item));
  }

  return { answer, picks, warnings, degraded: false };
}

/**
 * No model, or nothing usable came back. Return real dishes and duller copy --
 * a guest is better served by a correct list than by an apology.
 */
function degrade(menu: PublicItem[], note: string): AdviceResult {
  const picks = pickSpread(menu).map((item) => ({
    item,
    role: item.course,
    why: item.tasteTags.slice(0, 2).join(", ") || item.cuisine,
  }));

  return {
    answer: `${note} ${sentenceFor(picks.map((p) => p.item))}`.trim(),
    picks,
    warnings: [{
      code: "ADVICE_DEGRADED",
      message: "Suggestions were chosen by the menu's own popularity, not written for you.",
    }],
    degraded: true,
  };
}

/** One dish per course, most popular first, so the fallback still reads as a meal. */
function pickSpread(menu: PublicItem[]): PublicItem[] {
  const order = ["Starter", "MainCourse", "Bread", "Sides", "Dessert"];
  const out: PublicItem[] = [];
  for (const course of order) {
    const best = menu.find((i) => i.course === course && !out.includes(i));
    if (best) out.push(best);
    if (out.length >= 4) break;
  }
  return out.length > 0 ? out : menu.slice(0, 3);
}

function sentenceFor(items: PublicItem[]): string {
  const names = items.map((i) => i.name);
  if (names.length === 0) return "Nothing on tonight's menu fits that.";
  if (names.length === 1) return `${names[0]} is the one I would go for.`;
  const last = names.pop()!;
  return `${names.join(", ")} and ${last} work well together.`;
}
