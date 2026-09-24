import type { Prisma } from "../../generated/prisma/client.ts";
import { prisma } from "../../db/index.ts";
import type { ListItemsInput } from "../schemas/menu.schema.ts";
import { DRINK_COURSES, FOOD_COURSES } from "../domain/menu.constants.ts";
import { ORDERABLE } from "./menu.filter.ts";
import { classifyDrink, type DrinkStyle } from "../domain/abv.ts";

/** Reads the menu straight from Postgres. */

export { DRINK_COURSES, FOOD_COURSES };

/** The order courses are shown in on the menu page. */
const COURSE_ORDER = [
  "Starter", "Salad", "MainCourse", "Bread", "Sides", "Dessert",
  "Beverage", "Alcohol", "Shisha",
];

const COURSE_LABELS: Record<string, string> = {
  Starter: "Small plates",
  Salad: "Salads",
  MainCourse: "Mains",
  Bread: "Breads",
  Sides: "Sides",
  Dessert: "Desserts",
  Beverage: "Drinks",
  Alcohol: "Bar",
  Shisha: "Lounge",
};

export type PublicItem = {
  id: string;
  name: string;
  desc: string | null;
  /** Rupees. Null only if a row somehow escaped the seeder. */
  price: number | null;
  cuisine: string;
  course: string;
  diet: string;
  protein: string;
  spice: number;
  /** Null, or below 0.5, means the heat level was never confidently assessed. */
  spiceConfidence: number | null;
  tasteTags: string[];
  /** POS merchandising tags: bestseller, trending, chefs-special... */
  tags: string[];
  servesMin: number;
  servesMax: number;
  /**
   * Verified allergens only, and usually empty. The POS column of the same name
   * was merchandising copy and is now in `tags`, where it cannot be mistaken for
   * a safety claim.
   */
  allergens: string[];
  allergensVerified: boolean;
  imageUrl: string | null;
  /**
   * Estimated % ABV, from the name and style (src/domain/abv.ts). 0 for soft
   * drinks, null for food. An estimate -- show it as "~40%", never as a label.
   */
  abv: number | null;
  /** beer, wine, cocktail, whisky... "none" for soft drinks, null for food. */
  drinkStyle: DrinkStyle | null;
};

type ItemRowish = {
  id: string; name: string; desc: string | null;
  price: Prisma.Decimal | number | string | null;
  cuisine: string; course: string; diet: string; protein: string;
  spice: number; spiceConfidence: number | null;
  tasteTags: string[]; tags: string[]; popularity?: number;
  allergens: string[]; allergensVerified: boolean;
  servesMin: number; servesMax: number; imageUrl: string | null;
};

/**
 * Prisma hands back `Decimal` for a numeric column, and `JSON.stringify` turns
 * that into an object rather than a number -- so the price has to be converted
 * here or the client renders "[object Object]". It type-checks either way,
 * which is what makes it easy to miss.
 */
function toNumber(price: ItemRowish["price"]): number | null {
  if (price == null) return null;
  const n = typeof price === "object" ? Number(price.toString()) : Number(price);
  return Number.isFinite(n) ? n : null;
}

function drinkFacts(row: ItemRowish): Pick<PublicItem, "abv" | "drinkStyle"> {
  const drink = classifyDrink(row);
  return { abv: drink?.abv ?? null, drinkStyle: drink?.style ?? null };
}

export function toPublicItem(row: ItemRowish): PublicItem {
  return {
    id: row.id,
    name: row.name,
    desc: row.desc,
    price: toNumber(row.price),
    cuisine: row.cuisine,
    course: row.course,
    diet: row.diet,
    protein: row.protein,
    spice: row.spice,
    // Below 0.5 the classifier was guessing; don't present a number as fact.
    spiceConfidence: row.spiceConfidence,
    tasteTags: row.tasteTags,
    tags: row.tags,
    servesMin: row.servesMin,
    servesMax: row.servesMax,
    allergens: row.allergens,
    allergensVerified: row.allergensVerified,
    imageUrl: row.imageUrl,
    ...drinkFacts(row),
  };
}

export async function listItems(input: ListItemsInput) {
  const where: Prisma.ItemWhereInput = { ...ORDERABLE };

  if (input.course) {
    where.course = input.course as Prisma.ItemWhereInput["course"];
  } else if (input.group === "food") {
    where.course = { in: [...FOOD_COURSES] as never };
  } else if (input.group === "drink") {
    where.course = { in: [...DRINK_COURSES] as never };
  }

  if (input.diet === "veg") where.diet = { in: ["Vegetarian", "Jain"] as never };
  if (input.diet === "nonveg") where.diet = { in: ["NonVegetarian", "OnlyFish"] as never };

  if (input.q) {
    where.OR = [
      { name: { contains: input.q, mode: "insensitive" } },
      { desc: { contains: input.q, mode: "insensitive" } },
    ];
  }

  if (input.maxPrice != null) where.price = { lte: input.maxPrice };
  if (input.partySize != null) where.servesMax = { gte: input.partySize };
  if (input.tag) where.tags = { has: input.tag };

  const rows = await prisma.item.findMany({
    where,
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    take: input.limit,
  });

  const items = rows.map(toPublicItem);

  // Grouped by course so the page can render sections without regrouping.
  const byCourse = new Map<string, PublicItem[]>();
  for (const item of items) {
    const list = byCourse.get(item.course) ?? [];
    list.push(item);
    byCourse.set(item.course, list);
  }

  const sections = COURSE_ORDER.filter((c) => byCourse.has(c)).map((course) => ({
    course,
    label: COURSE_LABELS[course] ?? course,
    items: byCourse.get(course)!,
  }));

  return { total: items.length, sections, items };
}

/** Counts for the staff dashboard. Includes rows a guest would never see. */
export async function itemStats() {
  const rows = await prisma.item.findMany({
    select: {
      course: true, diet: true, spice: true, spiceConfidence: true,
      cuisine: true, price: true, derivedFrom: true, soldOut: true,
      isAvailable: true,
    },
  });

  const tally = (pick: (r: (typeof rows)[number]) => string) => {
    const out: Record<string, number> = {};
    for (const r of rows) out[pick(r)] = (out[pick(r)] ?? 0) + 1;
    return out;
  };

  const food = rows.filter((r) => (FOOD_COURSES as readonly string[]).includes(r.course));
  const prices = rows.map((r) => Number(r.price?.toString() ?? 0)).filter((n) => n > 0);

  return {
    total: rows.length,
    food: food.length,
    drink: rows.length - food.length,
    byCourse: tally((r) => r.course),
    byDiet: tally((r) => r.diet),
    byCuisine: tally((r) => r.cuisine),
    /** Food dishes per heat level -- the axis the recommendation engine leans on. */
    spiceSpread: food.reduce<Record<number, number>>((acc, r) => {
      acc[r.spice] = (acc[r.spice] ?? 0) + 1;
      return acc;
    }, {}),
    /** Rows nobody has confidently assessed, so staff know what to review. */
    lowConfidenceSpice: food.filter((r) => (r.spiceConfidence ?? 0) < 0.5).length,
    /** Where each row's classification came from. `manual` is never overwritten. */
    byProvenance: tally((r) => r.derivedFrom),
    unavailable: rows.filter((r) => r.soldOut || !r.isAvailable).length,
    price: prices.length
      ? {
          min: Math.min(...prices),
          max: Math.max(...prices),
          median: prices.sort((a, b) => a - b)[Math.floor(prices.length / 2)]!,
        }
      : null,
  };
}
