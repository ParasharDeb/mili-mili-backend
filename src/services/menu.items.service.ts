import type { Prisma } from "../../generated/prisma/client.ts";
import { prisma } from "../../db/index.ts";
import type { ListItemsInput } from "../schemas/menu.schema.ts";

/** Reads the menu straight from Postgres. No vectors involved. */

export const FOOD_COURSES = ["Starter", "MainCourse", "Bread", "Salad", "Dessert", "Sides"] as const;
export const DRINK_COURSES = ["Beverage", "Alcohol", "Shisha"] as const;

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
  cuisine: string;
  course: string;
  diet: string;
  protein: string;
  spice: number;
  /** Null when the spice level was never assessed with confidence. */
  spiceConfidence: number | null;
  tasteTags: string[];
  serves: number[];
  allergens: string | null;
};

export function toPublicItem(row: {
  id: string; name: string; desc: string | null; cuisine: string; course: string;
  diet: string; protein: string; spice: number; spiceConfidence: number | null;
  tasteTags: string[]; serves: number[]; allergens: string | null;
}): PublicItem {
  return {
    id: row.id, name: row.name, desc: row.desc, cuisine: row.cuisine,
    course: row.course, diet: row.diet, protein: row.protein, spice: row.spice,
    // Below 0.5 the enrichment was guessing; don't present a number as fact.
    spiceConfidence: row.spiceConfidence,
    tasteTags: row.tasteTags, serves: row.serves, allergens: row.allergens,
  };
}

export async function listItems(input: ListItemsInput) {
  const where: Prisma.ItemWhereInput = {};

  if (input.course) {
    where.course = input.course as Prisma.ItemWhereInput["course"];
  } else if (input.group === "food") {
    where.course = { in: [...FOOD_COURSES] as never };
  } else if (input.group === "drink") {
    where.course = { in: [...DRINK_COURSES] as never };
  }

  if (input.diet === "veg") where.diet = { in: ["Vegeterian", "Jain"] as never };
  if (input.diet === "nonveg") where.diet = { in: ["Non_vegeterian", "OnlyFish"] as never };

  if (input.q) {
    where.OR = [
      { name: { contains: input.q, mode: "insensitive" } },
      { desc: { contains: input.q, mode: "insensitive" } },
    ];
  }

  const rows = await prisma.item.findMany({
    where,
    orderBy: [{ name: "asc" }],
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

/** Counts for the staff dashboard. */
export async function itemStats() {
  const rows = await prisma.item.findMany({
    select: { course: true, diet: true, spice: true, spiceConfidence: true, cuisine: true },
  });

  const tally = (pick: (r: (typeof rows)[number]) => string) => {
    const out: Record<string, number> = {};
    for (const r of rows) out[pick(r)] = (out[pick(r)] ?? 0) + 1;
    return out;
  };

  const food = rows.filter((r) => (FOOD_COURSES as readonly string[]).includes(r.course));

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
    /** Rows the enrichment was unsure about, so staff know what to review. */
    lowConfidenceSpice: food.filter((r) => (r.spiceConfidence ?? 0) < 0.5).length,
  };
}
