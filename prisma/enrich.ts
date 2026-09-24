/**
 * LLM enrichment for menu items. Ported from rag/menu_rag/enrichment.py when the
 * Python pipeline was retired.
 *
 *   bun run prisma/enrich.ts [--limit=N] [--batch-size=N] [--dry-run] [--all]
 *
 * The heuristic classifier in prisma/classifyItem.ts cannot express what the
 * chat actually filters on. It reads heat off the literal word "chilli", which
 * appears on a handful of dishes, so it leaves most of the kitchen unassessed.
 * This asks Mistral to read each dish the way a cook would.
 *
 * By default it only touches rows with no confident spice level. `--all`
 * re-reads everything. Rows a human has corrected (`derivedFrom = "manual"`)
 * are never touched either way -- that is what the column is for.
 *
 * Run AFTER prisma/seedItems.ts. Re-seeding re-runs the heuristic and throws
 * this work away.
 */

import { prisma } from "../db/index.ts";
import { applyHardRules } from "../src/domain/diet.hardrules.ts";
import { chatJson } from "../src/lib/mistral.ts";
import {
  COURSES,
  CUISINES,
  PROTEINS,
  SPICE_MIN_CONFIDENCE,
  TASTE_TAGS,
  type Course,
  type Cuisine,
  type Diet,
  type Protein,
} from "../src/domain/menu.constants.ts";

/* ----------------------------------------------------------------- args -- */

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

const dryRun = argv.includes("--dry-run");
const enrichAll = argv.includes("--all");
/**
 * Re-apply the deterministic guards to what is already in the database, with no
 * model calls at all.
 *
 * Exists because the guards get tightened when one slips through -- the model
 * once filed "Paneer Tikka Masala" as non-vegetarian with protein Prawns -- and
 * the fix must not cost the enrichment that is already there. Re-seeding would
 * clobber it; this repairs in place.
 */
const rulesOnly = argv.includes("--rules-only");
const limit = Number(flag("limit")) || Infinity;
const batchSize = Number(flag("batch-size")) || 15;

/* ------------------------------------------------------------ vocabulary -- */

/**
 * The model answers in diner language and we map here. This indirection used to
 * exist because the Prisma enum was misspelled; it survives the rename because
 * "veg"/"nonveg" is simply what the model is reliable at emitting.
 */
const DIET_TO_DB: Record<string, Diet> = {
  veg: "Vegetarian",
  nonveg: "NonVegetarian",
  egg: "Eggetarian",
  fish: "OnlyFish",
  jain: "Jain",
};

const DIET_ALIASES: Record<string, string> = {
  vegetarian: "veg", "pure veg": "veg", vegan: "veg",
  "non-veg": "nonveg", "non veg": "nonveg", nonvegetarian: "nonveg",
  "non-vegetarian": "nonveg", meat: "nonveg",
  eggetarian: "egg", pescatarian: "fish", seafood: "fish", onlyfish: "fish",
};

/** The model reaches for US spellings and sometimes echoes a POS tag. */
const TASTE_ALIASES: Record<string, string> = {
  savory: "savoury", zesty: "tangy", sour: "tangy", hot: "spicy",
  buttery: "rich", "creamy rich": "creamy", fresh: "refreshing",
};

/** It also reaches for Course values in the Cuisine slot. */
const CUISINE_ALIASES: Record<string, string> = {
  alcohol: "Beverage", drinks: "Beverage", drink: "Beverage", cocktail: "Beverage",
  beverages: "Beverage", bar: "Beverage", shisha: "Other", hookah: "Other",
  chinese: "Asian", thai: "Asian", japanese: "Asian", oriental: "Asian",
  "north indian": "Indian", punjabi: "Indian", desi: "Indian", mughlai: "Indian",
  american: "Continental", european: "Continental", french: "Continental",
  mexican: "Continental", western: "Continental",
};

const COURSE_ALIASES: Record<string, string> = {
  main: "MainCourse", "main course": "MainCourse", maincourse: "MainCourse",
  entree: "MainCourse", appetizer: "Starter", appetiser: "Starter", snack: "Starter",
  side: "Sides", breads: "Bread", drink: "Beverage", mocktail: "Beverage",
  juice: "Beverage", liquor: "Alcohol", wine: "Alcohol", beer: "Alcohol",
  spirits: "Alcohol", hookah: "Shisha", desserts: "Dessert",
};

/** Case-insensitive match, then alias, then give up and keep what we had. */
function pick<T extends string>(
  value: unknown,
  allowed: readonly T[],
  aliases: Record<string, string>,
  fallback: T,
): T {
  const v = String(value ?? "").trim();
  const exact = allowed.find((a) => a.toLowerCase() === v.toLowerCase());
  if (exact) return exact;
  const mapped = aliases[v.toLowerCase()];
  return (allowed as readonly string[]).includes(mapped!) ? (mapped as T) : fallback;
}

/** Normalise to the closed vocabulary, dedupe, keep at most 4. */
function cleanTasteTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const raw of tags) {
    const key = String(raw ?? "").trim().toLowerCase();
    const t = TASTE_ALIASES[key] ?? key;
    if ((TASTE_TAGS as readonly string[]).includes(t) && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 4);
}

/* --------------------------------------------------------------- prompt -- */

const SYSTEM_PROMPT = `You are a chef cataloguing a restaurant menu in India. For each numbered dish
you are given a name, an optional description, and the merchandising tags the POS carried.

Return JSON only, shaped {"items":[{...}]}, one object per dish, echoing its "index":
{"index":<int>,"spice":<0-5>,"spice_confidence":<0.0-1.0>,"taste_tags":[<strings>],
 "cuisine":"<${CUISINES.join("|")}>","course":"<${COURSES.join("|")}>",
 "protein":"<${PROTEINS.join("|")}>","diet":"<veg|nonveg|egg|fish|jain>"}

SPICE is the most important field, and the reason for this task. Judge heat from what the dish
ACTUALLY IS, not from whether the word "chilli" appears:
- Indian curries, masalas, tikka, kadhai, kolhapuri, achari, vindaloo, rogan josh carry real heat (3-4).
- Tandoori and kebab marinades are moderately spiced (2-3).
- Chilli/Schezwan/peri-peri/Hot Garlic dishes are hot (4-5).
- Jalapeno, wasabi, gochujang, mustard, black pepper all add heat (2-4).
- Breads, desserts, salads, plain rice, most Italian and Continental dishes are 0-1.
- Alcohol, shisha and soft drinks are 0.
Set "spice_confidence" honestly: ~0.9 when the dish name makes the heat obvious, ~0.5 when you are
inferring from cuisine alone, ~0.2 when the name is opaque (a brand name, or "Chef's Special").

TASTE_TAGS: choose ONLY from this list, at most 4, and only ones you are confident about.
Never copy a POS tag (Boozy, Bar, Veg, Trending, Bestseller, New, Chef's Special) into taste_tags:
${TASTE_TAGS.join(", ")}

COURSE: use Alcohol for spirits/wine/beer/cocktails, Shisha for hookah and paan, Beverage for
soft drinks/juices/mocktails, and the food courses for food. Bottles and 30ml pours are Alcohol.

CUISINE is a FOOD STYLE and never a drink type. "Alcohol", "Shisha" and "Cocktail" are NOT
cuisines. For any drink (spirit, wine, beer, cocktail, juice, soft drink) use cuisine "Beverage".
For shisha/hookah/paan use cuisine "Other".

DIET: "veg" (no meat, no egg), "nonveg" (meat/poultry/seafood), "egg" (egg but no meat),
"fish" (fish/seafood but no other meat), "jain" (no onion, no garlic, no root vegetables).
Note the POS tags are unreliable here -- many meat dishes are tagged "Veg". Trust the dish name.

PROTEIN: the main protein, or "None" for drinks, breads, and vegetable dishes without paneer/tofu.`;

/* ----------------------------------------------------------------- work -- */

type Row = {
  id: string;
  name: string;
  desc: string | null;
  cuisine: Cuisine;
  course: Course;
  diet: Diet;
  protein: Protein;
  spice: number;
  tags: string[];
};

function renderItem(index: number, item: Row): string {
  const bits = [`${index}. ${item.name}`];
  if (item.desc?.trim()) bits.push(`   description: ${item.desc.trim()}`);
  if (item.tags.length) bits.push(`   pos tags: ${item.tags.join(", ")}`);
  return bits.join("\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Mistral's free tier rate limits hard enough that the client's own retries get
 * exhausted, so back off explicitly: 4s, 8s, 16s, 32s, 64s with jitter.
 */
async function enrichBatch(items: Row[], maxAttempts = 6): Promise<Map<string, any>> {
  const listing = items.map((it, i) => renderItem(i, it)).join("\n");

  let raw: any;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      raw = await chatJson(
        [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Catalogue these ${items.length} dishes:\n\n${listing}` },
        ],
        // ~120 tokens per dish of JSON, plus headroom. A batch that runs out of
        // budget comes back as truncated JSON and costs all fifteen dishes.
        { maxTokens: 220 * items.length, timeoutMs: 120_000 },
      );
      break;
    } catch (err) {
      const text = String(err).toLowerCase();
      const rateLimited = text.includes("429") || text.includes("rate limit") || text.includes("unavailable");
      if (!rateLimited || attempt === maxAttempts - 1) throw err;
      const wait = 2 ** (attempt + 2) * 1000 + Math.random() * 1500;
      console.log(`      rate limited, retrying in ${(wait / 1000).toFixed(1)}s (attempt ${attempt + 2}/${maxAttempts})`);
      await sleep(wait);
    }
  }

  // The model is asked for {"items":[...]} but reaches for "dishes", "results"
  // and a bare array often enough that guessing wrong silently costs the whole
  // batch -- which is exactly what it did the first time this ran.
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.items) ? raw.items
    : Array.isArray(raw?.dishes) ? raw.dishes
    : Array.isArray(raw?.results) ? raw.results
    : Array.isArray(raw?.data) ? raw.data
    : null;

  if (!list) {
    throw new Error(
      `unrecognised response shape (top-level keys: ${Object.keys(raw ?? {}).join(", ") || "none"})`,
    );
  }

  const out = new Map<string, any>();
  list.forEach((e: any, position: number) => {
    // `index` is what we asked for, but a model that omits it still returns the
    // dishes in order, so position is a sound fallback.
    const i = Number.isInteger(Number(e?.index)) ? Number(e.index) : position;
    if (i >= 0 && i < items.length) out.set(items[i]!.id, e);
  });
  return out;
}

/**
 * Normalise one enrichment into a DB-ready row. Every field falls back to the
 * item's current value rather than failing, so a single odd answer costs one
 * attribute instead of the whole dish.
 */
function toUpdate(item: Row, e: any) {
  const dietToken = DIET_ALIASES[String(e?.diet ?? "").trim().toLowerCase()]
    ?? String(e?.diet ?? "").trim().toLowerCase();

  const ruled = applyHardRules(
    {
      cuisine: pick(e?.cuisine, CUISINES, CUISINE_ALIASES, item.cuisine),
      course: pick(e?.course, COURSES, COURSE_ALIASES, item.course),
      diet: DIET_TO_DB[dietToken] ?? item.diet,
      protein: pick(e?.protein, PROTEINS, {}, item.protein),
      spice: Math.max(0, Math.min(5, Number(e?.spice) || 0)),
      spiceConfidence: Math.max(0, Math.min(1, Number(e?.spice_confidence) || 0)),
    },
    { name: item.name, desc: item.desc, tags: item.tags },
  );

  return {
    ...ruled,
    tasteTags: cleanTasteTags(e?.taste_tags),
    derivedFrom: "llm" as const,
    derivedAt: new Date(),
  };
}

/* ----------------------------------------------------------------- main -- */

const where = {
  // A human's correction is never overwritten by a model. That is the whole
  // point of tracking provenance.
  derivedFrom: { not: "manual" as const },
  ...(enrichAll
    ? {}
    : { OR: [{ spiceConfidence: null }, { spiceConfidence: { lt: SPICE_MIN_CONFIDENCE } }] }),
};

const items = (await prisma.item.findMany({
  where,
  orderBy: { name: "asc" },
  select: {
    id: true, name: true, desc: true, cuisine: true, course: true,
    diet: true, protein: true, spice: true, tags: true,
  },
})) as Row[];

if (rulesOnly) {
  const all = (await prisma.item.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true, name: true, desc: true, cuisine: true, course: true,
      diet: true, protein: true, spice: true, tags: true,
    },
  })) as Row[];

  let fixed = 0;
  for (const item of all) {
    const ruled = applyHardRules(
      {
        cuisine: item.cuisine, course: item.course, diet: item.diet,
        protein: item.protein, spice: item.spice, spiceConfidence: 1,
      },
      { name: item.name, desc: item.desc, tags: item.tags },
    );

    const changes: string[] = [];
    if (ruled.diet !== item.diet) changes.push(`diet ${item.diet}->${ruled.diet}`);
    if (ruled.protein !== item.protein) changes.push(`protein ${item.protein}->${ruled.protein}`);
    if (ruled.course !== item.course) changes.push(`course ${item.course}->${ruled.course}`);
    if (ruled.cuisine !== item.cuisine) changes.push(`cuisine ${item.cuisine}->${ruled.cuisine}`);
    if (changes.length === 0) continue;

    console.log(`  ${item.name}: ${changes.join(", ")}`);
    if (!dryRun) {
      await prisma.item.update({
        where: { id: item.id },
        data: {
          diet: ruled.diet, protein: ruled.protein,
          course: ruled.course, cuisine: ruled.cuisine,
        },
      });
    }
    fixed++;
  }

  console.log(`[enrich] hard rules corrected ${fixed} of ${all.length} items${dryRun ? " (dry run)" : ""}`);
  await prisma.$disconnect();
  process.exit(0);
}

const todo = items.slice(0, limit);
console.log(
  `[enrich] ${todo.length} items to catalogue` +
    (enrichAll ? " (--all)" : " (unassessed or low-confidence spice only)") +
    (dryRun ? " [dry run]" : ""),
);

let updated = 0;
let failed = 0;

for (let i = 0; i < todo.length; i += batchSize) {
  const batch = todo.slice(i, i + batchSize);
  const label = `${i + 1}-${Math.min(i + batchSize, todo.length)}/${todo.length}`;

  let enriched: Map<string, any>;
  try {
    enriched = await enrichBatch(batch);
  } catch (err) {
    // One bad batch must not cost the run. Report it and carry on.
    console.error(`[enrich] ${label} failed: ${err instanceof Error ? err.message : err}`);
    failed += batch.length;
    continue;
  }

  for (const item of batch) {
    const e = enriched.get(item.id);
    if (!e) {
      failed++;
      continue;
    }
    const data = toUpdate(item, e);
    if (dryRun) {
      console.log(
        `  ${item.name}: spice ${item.spice} -> ${data.spice} (${data.spiceConfidence?.toFixed(2)}), ` +
          `${item.cuisine}/${item.course}/${item.diet} -> ${data.cuisine}/${data.course}/${data.diet}, ` +
          `tastes ${data.tasteTags.join(",") || "-"}`,
      );
    } else {
      await prisma.item.update({ where: { id: item.id }, data });
    }
    updated++;
  }

  console.log(`[enrich] ${label} done`);
}

console.log(`[enrich] ${updated} updated, ${failed} skipped`);
await prisma.$disconnect();
