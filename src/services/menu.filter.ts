import type { Slot } from "../schemas/menu.schema.ts";

/**
 * Pure slot -> Pinecone filter mapping. No I/O, so it can be reasoned about and
 * tested on its own. This is the highest-risk logic in the feature: a mistake
 * here serves a vegetarian a chicken dish.
 */

export const FOOD_COURSES = ["Starter", "MainCourse", "Bread", "Salad", "Dessert", "Sides"];
export const DRINK_COURSES = ["Beverage", "Alcohol", "Shisha"];

/**
 * `Item.diet` means "suitable for this kind of diner", so a diner constraint is
 * normally a WIDENING. `nonveg` is the exception: the guest is asking for meat,
 * which NARROWS. Getting that backwards makes "1 non veg" return paneer tikka.
 *
 * `Eggeterian` is deliberately excluded from `veg` (in Indian usage egg is not
 * vegetarian). `Jain` is included in `veg` because Jain is strictly stricter,
 * but `veg` is never included in `jain`.
 */
const DIET_FILTERS: Record<string, string[] | null> = {
  veg: ["Vegeterian", "Jain"],
  jain: ["Jain"],
  egg: ["Vegeterian", "Jain", "Eggeterian"],
  fish: ["Vegeterian", "Jain", "Eggeterian", "OnlyFish"],
  nonveg: ["Non_vegeterian", "OnlyFish"],
  any: null,
};

/** Bands overlap on purpose: with ~80 food items, disjoint bands strand slots. */
const SPICE_FILTERS: Record<string, Record<string, number> | null> = {
  none: { $lte: 1 },
  mild: { $gte: 1, $lte: 2 },
  medium: { $gte: 2, $lte: 3 },
  spicy: { $gte: 3 },
  very_spicy: { $gte: 4 },
  any: null,
};

export type PineconeFilter = Record<string, unknown> | undefined;

export function buildFilter(slot: Slot, includeDrinks: boolean): PineconeFilter {
  const clauses: Record<string, unknown>[] = [];

  const diets = DIET_FILTERS[slot.diet];
  if (diets && diets.length > 0) clauses.push({ diet: { $in: diets } });

  const spice = SPICE_FILTERS[slot.spice];
  if (spice) clauses.push({ spice });

  if (slot.cuisine !== "any") clauses.push({ cuisine: { $eq: slot.cuisine } });

  // A specific course wins; courseGroup only applies when none was stated.
  // An explicit allowlist (not $nin) so a future CourseEnum value fails closed.
  if (slot.course !== "any") {
    clauses.push({ course: { $eq: slot.course } });
  } else if (!includeDrinks && slot.courseGroup === "food") {
    clauses.push({ course: { $in: FOOD_COURSES } });
  } else if (!includeDrinks && slot.courseGroup === "drink") {
    clauses.push({ course: { $in: DRINK_COURSES } });
  }

  return clauses.length > 0 ? { $and: clauses } : undefined;
}

/** Ordered rungs tried when a slot can't fill `perSlot`. Diet is never relaxed. */
export const RELAXATIONS = [
  "spice_widened",
  "cuisine_softened",
  "spice_dropped",
  "course_dropped",
] as const;
export type Relaxation = (typeof RELAXATIONS)[number];

/**
 * Returns the slot rewritten for one rung of relaxation, or null when that rung
 * would not change anything.
 *
 * The diet clause is intentionally untouchable. A guest shown two dishes instead
 * of three is a degraded result; a vegetarian shown chicken is a broken promise.
 */
export function relaxSlot(slot: Slot, rung: Relaxation): Slot | null {
  switch (rung) {
    case "spice_widened": {
      if (slot.spice === "any") return null;
      const widen: Record<string, Slot["spice"]> = {
        none: "mild", mild: "medium", medium: "spicy",
        spicy: "medium", very_spicy: "spicy",
      };
      return { ...slot, spice: widen[slot.spice] ?? "any" };
    }
    case "cuisine_softened":
      // Drop the hard cuisine filter but keep the word in searchText, so the
      // embedding still carries the preference softly.
      if (slot.cuisine === "any") return null;
      return { ...slot, cuisine: "any", searchText: `${slot.searchText} ${slot.cuisine}` };
    case "spice_dropped":
      if (slot.spice === "any") return null;
      return { ...slot, spice: "any" };
    case "course_dropped":
      if (slot.course === "any" && slot.courseGroup === "any") return null;
      return { ...slot, course: "any", courseGroup: "any" };
  }
}

/**
 * Does an item's stored diet satisfy a slot's diet constraint?
 *
 * Used to re-check rows hydrated from Postgres. Pinecone metadata is only a
 * snapshot, refreshed when someone re-runs `python ingest.py`, so an item edited
 * in the database keeps matching the old filter until then. For diet that is not
 * a ranking miss, it is a vegetarian being handed chicken.
 */
export function dietAllows(slotDiet: string, itemDiet: string): boolean {
  const allowed = DIET_FILTERS[slotDiet];
  return allowed == null ? true : allowed.includes(itemDiet);
}

/** The courses a slot is willing to accept, or null when unconstrained. */
export function allowedCourses(slot: Slot, includeDrinks: boolean): string[] | null {
  if (slot.course !== "any") return [slot.course];
  if (includeDrinks) return null;
  if (slot.courseGroup === "food") return FOOD_COURSES;
  if (slot.courseGroup === "drink") return DRINK_COURSES;
  return null;
}
