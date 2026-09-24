import { isChatConfigured } from "../lib/env.ts";
import { chatJson } from "../lib/mistral.ts";
import { POPULARITY_TAGS } from "../domain/menu.constants.ts";
import { candidateNames, IGNORE_PHRASES, render } from "./menu.advise.service.ts";
import { dietAllows } from "./menu.filter.ts";
import { getFullMenu } from "./menu.sql.service.ts";
import type { PublicItem } from "./menu.items.service.ts";

/**
 * Three combos, three items each: "Murgh Makhani, two Chilli Cheese Kulcha and
 * a raita" rather than a list of five unrelated dishes.
 *
 * The whole orderable menu goes to the model. The advisory path pre-slices it;
 * here the pairing IS the judgement, and the menu has no dish called "naan" --
 * only a model looking at the real names can put a kulcha next to a curry.
 *
 * Quantities are suggestions. The UI renders each item with a stepper and adds
 * whatever the guest settles on, so `qty` here is a starting point scaled to
 * the party, never a bundle.
 *
 * The gates are the ones advise() uses: a ref that is not on the list never
 * becomes a card, a diet that was asked for is re-checked on every pick, and a
 * model that fails or is absent degrades to combos built from popularity.
 */

export type ComboRole = "Main" | "Bread" | "Rice" | "Side" | "Starter" | "Dessert" | "Drink";

export type ComboItem = { item: PublicItem; qty: number; role: ComboRole; why: string };
export type Combo = { id: string; title: string; why: string; items: ComboItem[] };

export type ComboResult = {
  answer: string;
  combos: Combo[];
  warnings: { code: string; message: string }[];
  degraded: boolean;
};

const COMBO_COUNT = 3;
const ITEMS_PER_COMBO = 3;

const SYSTEM_PROMPT = `You are the pass at Milli, a restaurant. A guest wants you to put together combos from tonight's menu.

You will be given the whole menu as numbered lines: ref|name|diet|cuisine|course|heat|price|tastes.
Diet is V (vegetarian), NV (non-vegetarian), E (egg), F (seafood), J (jain).
Heat is h0 to h5, or h? when the kitchen never recorded it.

Return JSON only:
{"answer":"<1-2 sentences>","combos":[{"title":"<max 5 words>","why":"<max 15 words>","items":[{"ref":<number>,"role":"<Main|Bread|Rice|Side|Starter|Dessert|Drink>","qty":<number>,"why":"<max 10 words>"}]}]}

Rules:
- Exactly ${COMBO_COUNT} combos. Each has exactly ${ITEMS_PER_COMBO} items with ${ITEMS_PER_COMBO} different refs.
- Every ref MUST be one of the numbered lines. Never invent a dish, price or ingredient.
- Each combo is a meal for the table: one Main, something to eat it with (a Bread for a curry,
  Rice or noodles for a stir-fry -- a pasta or pizza needs neither), and a Side, Starter,
  Dessert or Drink to round it off.
- Make the ${COMBO_COUNT} combos genuinely different -- different mains, ideally different
  cuisines -- unless the guest asked for one cuisine.
- qty is how many to order for the party size given: roughly one bread per person, one main
  per two people, one side or starter per two people, one drink per person. Minimum 1.
- In "answer", name dishes only by their EXACT names from the list, or do not name them.
- Where a dish shows h?, do not state a heat level.`;

/** Diet restricts food only -- every drink is stored as Vegetarian. */
const isDrink = (item: PublicItem) => item.course === "Beverage" || item.course === "Alcohol";

const ROLES: ComboRole[] = ["Main", "Bread", "Rice", "Side", "Starter", "Dessert", "Drink"];

/* ---------------------------------------------------------------- menu -- */

/**
 * The bar lists most spirits twice, as a 30ml pour and a bottle. Showing both
 * doubles the prompt for no new choice; keep the pour, which is what a combo
 * means, and drop its bottle.
 */
function drinkBase(name: string): string {
  return name
    .toLowerCase()
    .replace(/^btl\s+/, "")
    .replace(/\((30|150)\s*ml\)|\(btl\)|\bbtl\b|\d+\s*(ml|ltr)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isPour(name: string): boolean {
  return /30\s*ml|150\s*ml|glass/i.test(name) || !/btl|bottle|\d+\s*ltr/i.test(name);
}

export function collapseBar(menu: PublicItem[]): PublicItem[] {
  const keep = new Map<string, PublicItem>();
  const out: PublicItem[] = [];
  for (const item of menu) {
    if (item.course !== "Alcohol") {
      out.push(item);
      continue;
    }
    const key = drinkBase(item.name);
    const current = keep.get(key);
    if (!current || (isPour(item.name) && !isPour(current.name))) keep.set(key, item);
  }
  return [...out, ...keep.values()];
}

/* ------------------------------------------------------------ quantities -- */

export function defaultQty(role: ComboRole, party: number): number {
  const people = Math.max(1, party);
  const qty = role === "Bread" || role === "Drink" ? people : Math.ceil(people / 2);
  return Math.max(1, Math.min(20, qty));
}

function toRole(raw: unknown, item: PublicItem): ComboRole {
  const r = String(raw ?? "").trim().toLowerCase();
  const hit = ROLES.find((role) => role.toLowerCase() === r);
  if (hit) return hit;
  if (item.course === "Bread") return "Bread";
  if (item.course === "Dessert") return "Dessert";
  if (item.course === "Beverage" || item.course === "Alcohol") return "Drink";
  if (item.course === "Starter") return "Starter";
  if (item.course === "Sides" || item.course === "Salad") return "Side";
  return "Main";
}

/* ------------------------------------------------------------ validation -- */

type RawCombo = { title?: unknown; why?: unknown; items?: unknown };

/**
 * One model combo -> a Combo, or the reason it cannot be one.
 *
 * All-or-nothing per combo: a curry whose bread was an invented ref is not a
 * combo with two items, it is a broken suggestion, and gets replaced.
 */
function validateCombo(
  raw: RawCombo,
  refs: Map<number, PublicItem>,
  opts: { diet?: string; party: number },
): Combo | string {
  const items: ComboItem[] = [];
  const seen = new Set<string>();

  for (const pick of Array.isArray(raw?.items) ? raw.items : []) {
    const item = refs.get(Number((pick as { ref?: unknown })?.ref));
    if (!item) return "a dish that is not on the menu";
    if (seen.has(item.id)) continue;
    if (opts.diet && opts.diet !== "any" && !isDrink(item) && !dietAllows(opts.diet, item.diet)) {
      console.warn(`[combo] model picked ${item.name} (${item.diet}) for a '${opts.diet}' request`);
      return `${item.name}, which is not ${opts.diet}`;
    }
    seen.add(item.id);

    const role = toRole((pick as { role?: unknown }).role, item);
    const asked = Math.round(Number((pick as { qty?: unknown }).qty));
    items.push({
      item,
      role,
      qty: Number.isFinite(asked) && asked >= 1 ? Math.min(20, asked) : defaultQty(role, opts.party),
      why: String((pick as { why?: unknown }).why ?? "").slice(0, 80),
    });
  }

  if (items.length !== ITEMS_PER_COMBO) return `${items.length} items instead of ${ITEMS_PER_COMBO}`;

  return {
    id: "",
    title: String(raw.title ?? "").trim().slice(0, 40) || items[0]!.item.name,
    why: String(raw.why ?? "").trim().slice(0, 120),
    items,
  };
}

/** Same three dishes under a different title is not a different combo. */
function comboKey(combo: Combo): string {
  return combo.items.map((i) => i.item.id).sort().join("|");
}

function collect(
  raw: any,
  refs: Map<number, PublicItem>,
  opts: { diet?: string; party: number },
  into: Combo[],
): string[] {
  const problems: string[] = [];
  const taken = new Set(into.map(comboKey));
  const mains = new Set(into.map((c) => c.items.find((i) => i.role === "Main")?.item.id));

  for (const candidate of Array.isArray(raw?.combos) ? raw.combos : []) {
    if (into.length >= COMBO_COUNT) break;
    const result = validateCombo(candidate, refs, opts);
    if (typeof result === "string") {
      problems.push(`"${String(candidate?.title ?? "a combo")}" used ${result}`);
      continue;
    }
    const main = result.items.find((i) => i.role === "Main")?.item.id;
    if (taken.has(comboKey(result)) || (main && mains.has(main))) {
      problems.push(`"${result.title}" repeated another combo's main`);
      continue;
    }
    taken.add(comboKey(result));
    if (main) mains.add(main);
    into.push(result);
  }
  return problems;
}

/* ---------------------------------------------------------------- main -- */

export async function composeCombos(
  question: string,
  opts: { diet?: string; partySize?: number; includeDrinks?: boolean } = {},
): Promise<ComboResult> {
  const party = opts.partySize && opts.partySize > 0 ? opts.partySize : 2;
  const menu = collapseBar(await getFullMenu({ diet: opts.diet, includeDrinks: opts.includeDrinks }));

  if (menu.length === 0) {
    return {
      answer: "I cannot see anything on tonight's menu that fits that.",
      combos: [],
      warnings: [{ code: "COMBO_NO_MENU", message: "No dishes matched the stated constraints." }],
      degraded: false,
    };
  }

  if (!isChatConfigured) {
    return fallback(menu, party, opts.diet, "Set MISTRAL_API_KEY to get combos written for you.");
  }

  const { listing, refs } = render(menu);
  const warnings: ComboResult["warnings"] = [];
  const combos: Combo[] = [];
  const valOpts = { diet: opts.diet, party };

  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    {
      role: "user" as const,
      content:
        `Tonight's menu:\n${listing}\n\nParty size: ${party}\n` +
        (opts.diet && opts.diet !== "any" ? `Every food item must suit a ${opts.diet} diet; drinks are exempt.\n` : "") +
        (opts.includeDrinks ? `The guest wants drinks: make the third item of every combo a Drink.\n` : "") +
        `Guest asks: ${question}`,
    },
  ];

  let raw: any;
  try {
    raw = await chatJson(messages, { maxTokens: 1400, timeoutMs: 25_000 });
  } catch (err) {
    console.warn(`[combo] model unavailable: ${err instanceof Error ? err.message : err}`);
    return fallback(menu, party, opts.diet, "The kitchen's notes are not loading, so here is what goes together.");
  }

  let problems = collect(raw, refs, valOpts, combos);
  if (problems.length) console.warn(`[combo] rejected: ${problems.join("; ")}`);

  // One retry, told exactly what was wrong. Small models get the shape right far
  // more often on a second attempt than they do by luck on the first.
  if (combos.length < COMBO_COUNT) {
    try {
      const retry = await chatJson(
        [
          ...messages,
          { role: "assistant" as const, content: JSON.stringify(raw ?? {}) },
          {
            role: "user" as const,
            content:
              `Some combos could not be used: ${problems.join("; ") || "too few combos"}. ` +
              `Return the full JSON again with exactly ${COMBO_COUNT} combos of exactly ` +
              `${ITEMS_PER_COMBO} numbered menu items each, each combo with a different main.`,
          },
        ],
        { maxTokens: 1400, timeoutMs: 25_000 },
      );
      problems = collect(retry, refs, valOpts, combos);
      if (problems.length) console.warn(`[combo] rejected on retry: ${problems.join("; ")}`);
    } catch (err) {
      console.warn(`[combo] retry failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (combos.length < COMBO_COUNT) {
    const before = combos.length;
    const shown = combos.flatMap((c) => c.items.map((i) => i.item.id));
    combos.push(...buildFallbackCombos(menu, party, opts.diet, shown, COMBO_COUNT - combos.length));
    if (combos.length > before) {
      warnings.push({
        code: "COMBO_FILLED",
        message: `${combos.length - before} combo(s) were built from the menu's popular dishes because the suggestion was incomplete.`,
      });
    }
  }

  combos.forEach((c, i) => (c.id = `combo_${i + 1}`));

  // The prose is checked against the combos, not the menu -- same reasoning as
  // advise(): a real dish that is not on the cards is as confusing as a fake one.
  let answer = String(raw?.answer ?? "").trim();
  const shown = combos.flatMap((c) => c.items.map((i) => i.item.name.toLowerCase()));
  const mismatched = candidateNames(answer).filter((name) => {
    const n = name.toLowerCase();
    if (IGNORE_PHRASES.has(n) || n.length < 6) return false;
    if (combos.some((c) => c.title.toLowerCase() === n)) return false;
    return !shown.some((k) => k.includes(n) || n.includes(k));
  });
  if (!answer || mismatched.length > 0) {
    if (mismatched.length > 0) console.warn(`[combo] prose named dishes it did not pick: ${mismatched.join(", ")}`);
    answer = sentenceFor(combos);
  }

  return { answer, combos, warnings, degraded: false };
}

/* ------------------------------------------------------------ fallback -- */

function popularity(item: PublicItem): number {
  return (POPULARITY_TAGS as readonly string[]).filter((t) => item.tags.includes(t)).length;
}

const byPopularity = (a: PublicItem, b: PublicItem) =>
  popularity(b) - popularity(a) || (a.price ?? 0) - (b.price ?? 0) || a.name.localeCompare(b.name);

const CARB_RE = /\brice\b|noodle|chow\s*mein|pulao|biryani|hakka/i;
const NO_CARB_RE = /pasta|spaghetti|penne|rigatoni|lasagne|ravioli|risotto|pizza|margherita/i;

/**
 * Three combos from popularity alone. Dull, but every dish is real, every diet
 * promise holds, and the pairing rules are the ones the prompt states.
 */
export function buildFallbackCombos(
  menu: PublicItem[],
  party: number,
  diet?: string,
  exclude: Iterable<string> = [],
  count = COMBO_COUNT,
): Combo[] {
  const ok = (i: PublicItem) => !diet || diet === "any" || dietAllows(diet, i.diet);
  const food = menu.filter(ok);

  const mains = food
    .filter((i) => i.course === "MainCourse" && !CARB_RE.test(i.name))
    .sort(byPopularity);
  const breads = food.filter((i) => i.course === "Bread").sort(byPopularity);
  const carbs = food.filter((i) => i.course === "MainCourse" && CARB_RE.test(i.name)).sort(byPopularity);
  const sides = food
    .filter((i) => ["Starter", "Sides", "Salad"].includes(i.course))
    .sort(byPopularity);
  const desserts = food.filter((i) => i.course === "Dessert").sort(byPopularity);

  // Different cuisines first, then the rest by popularity. Walk them all until
  // three combos come out whole -- a main with nothing to pair it with is
  // skipped, not served as a two-item combo.
  const order = [
    ...mains.filter((m, i) => mains.findIndex((x) => x.cuisine === m.cuisine) === i),
    ...mains.filter((m, i) => mains.findIndex((x) => x.cuisine === m.cuisine) !== i),
  ];

  const used = new Set<string>(exclude);
  const pick = (pool: PublicItem[], prefer?: (i: PublicItem) => boolean) =>
    (prefer && pool.find((i) => !used.has(i.id) && prefer(i))) ?? pool.find((i) => !used.has(i.id));

  const combos: Combo[] = [];
  for (const main of order) {
    if (combos.length >= count) break;
    if (used.has(main.id)) continue;

    const sameCuisine = (i: PublicItem) => i.cuisine === main.cuisine;
    const chosen: { item: PublicItem; role: ComboRole; why: string }[] = [];

    if (!NO_CARB_RE.test(main.name)) {
      const carb = main.cuisine === "Indian"
        ? pick(breads)
        : main.cuisine === "Asian" ? pick(carbs, sameCuisine) : undefined;
      if (carb) {
        chosen.push({ item: carb, role: carb.course === "Bread" ? "Bread" : "Rice", why: `to go with the ${main.name}` });
      }
    }
    const taken = (i: PublicItem) => chosen.some((c) => c.item.id === i.id);
    const side = pick(sides.filter((i) => !taken(i)), sameCuisine);
    if (side) chosen.push({ item: side, role: toRole(undefined, side), why: side.course === "Starter" ? "to start" : "on the side" });
    if (chosen.length < 2) {
      const dessert = pick(desserts.filter((i) => !taken(i)));
      if (dessert) chosen.push({ item: dessert, role: "Dessert", why: "to finish" });
    }
    if (chosen.length < 2) {
      const another = pick(sides.filter((i) => !taken(i)));
      if (another) chosen.push({ item: another, role: toRole(undefined, another), why: "on the side" });
    }
    if (chosen.length < 2) continue;

    used.add(main.id);
    for (const c of chosen) used.add(c.item.id);
    const items: ComboItem[] = [
      { item: main, role: "Main", qty: defaultQty("Main", party), why: "a table favourite" },
      ...chosen.slice(0, 2).map((c) => ({ ...c, qty: defaultQty(c.role, party) })),
    ];
    combos.push({
      id: `combo_${combos.length + 1}`,
      title: `${main.cuisine === "Other" ? "House" : main.cuisine} ${combos.length === 0 ? "favourite" : "combo"}`,
      why: `${main.name} with ${items.slice(1).map((i) => i.item.name).join(" and ")}.`,
      items,
    });
  }
  return combos;
}

function fallback(menu: PublicItem[], party: number, diet: string | undefined, note: string): ComboResult {
  const combos = buildFallbackCombos(menu, party, diet);
  return {
    answer: `${note} ${sentenceFor(combos)}`.trim(),
    combos,
    warnings: [{
      code: "COMBO_DEGRADED",
      message: "Combos were put together from the menu's popular dishes, not written for you.",
    }],
    degraded: true,
  };
}

function sentenceFor(combos: Combo[]): string {
  if (combos.length === 0) return "I could not put a combo together from tonight's menu.";
  return `Here are ${combos.length} ways to go tonight -- adjust the quantities and add the one you like.`;
}
