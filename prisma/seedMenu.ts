/**
 * The restaurant's real menu -> Postgres. Replaces the Petpooja export.
 *
 *   bun run prisma/seedMenu.ts [--dry-run] [--keep-others]
 *
 * Reads prisma/menu.json, which is the cleaned form of the sheets in
 * public/menu/ (typos fixed, sections mapped to course/cuisine/diet, one row
 * per serve). Edit prices and descriptions THERE, then re-run this.
 *
 * `priceEstimated: true` marks a price nobody at the restaurant has set: the
 * food, cocktail and sober sheets carry no prices at all, and the newer bar
 * sheet carries only costs. Those were filled with plausible figures so the
 * column (NOT NULL) and the price filters work. Replace them before going live.
 *
 * Every item from another source (the old POS export) is DELETED at the end,
 * unless --keep-others is passed. Nothing references `items` by foreign key.
 *
 * Re-running is safe and keeps enrichment: on an existing row only the menu's
 * own facts are rewritten, never spice or taste, so `bun run db:enrich` output
 * survives. Run order for a fresh database: this, `bun run db:enrich`, then this
 * AGAIN -- enrichment re-guesses course, cuisine and diet and gets them wrong
 * (it filed "Braised Lamb" as a Dessert and "Grilled John Dory" as vegetarian);
 * the second run puts back what the menu itself says.
 */

import { readFile } from "node:fs/promises";
import { classifyItem, type SourceItem } from "./classifyItem.ts";
import { applyHardRules } from "../src/domain/diet.hardrules.ts";
import type { Course, Cuisine, Diet, Protein } from "../src/domain/menu.constants.ts";
import { prisma } from "../db/index.ts";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const keepOthers = argv.includes("--keep-others");

const MENU_SOURCE = "menu";

type MenuRow = {
  ref: string;
  name: string;
  desc?: string;
  price: number;
  priceEstimated: boolean;
  kind: "bar" | "cocktail" | "mocktail" | "food";
  category: string;
  sort: number;
  serves?: [number, number];
  /** Drinks only: the menu marks it with a chilli. */
  spicy?: boolean;
  /** Food only: from the section the dish sits in. */
  course?: Course;
  cuisine?: Cuisine;
  diet?: Diet;
  /** Set only where the name states a protein no classifier regex knows. */
  protein?: Protein;
};

const menu: MenuRow[] = JSON.parse(
  await readFile(new URL("./menu.json", import.meta.url), "utf8"),
);

function toItem(row: MenuRow) {
  const isFood = row.kind === "food";
  const isAlcohol = row.kind === "bar" || row.kind === "cocktail";

  // Only tags classifyItem already knows, so it reads the row without warnings.
  const tags = [
    isAlcohol && "Boozy, Bar",
    (row.kind === "mocktail" || (isFood && row.diet === "Vegetarian")) && "Veg",
    row.spicy && "Spicy",
  ].filter(Boolean);

  const source: SourceItem = {
    id: crypto.randomUUID(),
    name: row.name,
    description: row.desc ?? null,
    price: row.price,
    dietary_type: null,
    allergens: tags.join(", ") || null,
    sort: row.sort,
    category_id: row.category,
    source: MENU_SOURCE,
    external_ref: row.ref,
  };
  const item = classifyItem(source);

  // The menu's section is a stated fact, the classifier's regexes a guess:
  // "Kung Pao Potato" is a small plate whatever its name suggests. The hard
  // rules still get the last word, as they do in enrichment, so a kulcha is
  // filed as Bread and a prawn dish as pescatarian.
  if (isFood) {
    const ruled = applyHardRules(
      {
        cuisine: row.cuisine!,
        course: row.course!,
        diet: row.diet!,
        protein: row.protein ?? item.protein,
        spice: item.spice,
        spiceConfidence: item.spiceConfidence,
      },
      { name: row.name, desc: row.desc ?? null, tags: item.tags },
    );
    Object.assign(item, ruled);
  } else {
    Object.assign(item, {
      course: isAlcohol ? "Alcohol" : "Beverage",
      cuisine: "Beverage",
      diet: "Vegetarian",
      protein: "None",
      // A drink's heat is on the menu (the chilli mark), so it is assessed.
      spice: row.spicy ? 3 : 0,
      spiceConfidence: row.spicy ? 0.8 : 1,
    });
  }

  if (row.serves) [item.servesMin, item.servesMax] = row.serves;
  return item;
}

const items = menu.map(toItem);

const byCourse = new Map<string, number>();
for (const i of items) byCourse.set(i.course, (byCourse.get(i.course) ?? 0) + 1);
console.log(`[menu] ${items.length} items:`, Object.fromEntries(byCourse));
console.log(`[menu] ${menu.filter((r) => r.priceEstimated).length} have an estimated price`);

if (dryRun) {
  console.table(
    items.slice(0, 400).map((i) => ({ name: i.name, price: i.price, course: i.course, cuisine: i.cuisine, diet: i.diet, protein: i.protein })),
  );
  process.exit(0);
}

/**
 * Concurrent single-statement upserts, not a $transaction: Neon's PgBouncer
 * pooler will not hold an interactive transaction open long enough (P2028).
 * See prisma/seedItems.ts.
 */
const CONCURRENCY = 10;
let written = 0;

const upsert = (item: ReturnType<typeof toItem>) => {
  const { id: _id, spice, spiceConfidence, derivedFrom, derivedAt, tasteTags, ...facts } = item;
  return prisma.item.upsert({
    where: { item_source_ref: { source: MENU_SOURCE, externalRef: item.externalRef! } },
    create: item,
    update: facts,
  });
};

for (let i = 0; i < items.length; i += CONCURRENCY) {
  await Promise.all(items.slice(i, i + CONCURRENCY).map(upsert));
  written += Math.min(CONCURRENCY, items.length - i);
  process.stdout.write(`\r[menu] ${written}/${items.length}`);
}
process.stdout.write("\n");

// Rows dropped from menu.json since the last run.
const stale = await prisma.item.deleteMany({
  where: { source: MENU_SOURCE, externalRef: { notIn: items.map((i) => i.externalRef!) } },
});
if (stale.count) console.log(`[menu] removed ${stale.count} items no longer on the menu`);

if (!keepOthers) {
  const old = await prisma.item.deleteMany({ where: { source: { not: MENU_SOURCE } } });
  console.log(`[menu] deleted ${old.count} items from other sources (old POS export)`);
}

// Read back, not from `items`: a re-run keeps the enrichment already stored.
const unassessed = await prisma.item.count({
  where: { source: MENU_SOURCE, OR: [{ spiceConfidence: null }, { spiceConfidence: { lt: 0.5 } }] },
});
if (unassessed) {
  console.log(`[menu] ${unassessed} dishes have no assessed spice level. Run \`bun run db:enrich\` next.`);
}

await prisma.$disconnect();
