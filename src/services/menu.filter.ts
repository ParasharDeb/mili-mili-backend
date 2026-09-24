import type { Prisma } from "../../generated/prisma/client.ts";
import type { Slot } from "../schemas/menu.schema.ts";
import { DRINK_COURSES, FOOD_COURSES, type Diet } from "../domain/menu.constants.ts";
import { abvRange, isAlcoholic, SPIRIT_STYLES, type DrinkStyle } from "../domain/abv.ts";

/**
 * Pure slot -> Prisma `where` mapping. No I/O, so it can be reasoned about and
 * tested on its own. This is the highest-risk logic in the feature: a mistake
 * here serves a vegetarian a chicken dish.
 *
 * It used to emit a Pinecone metadata filter. The shape changed when retrieval
 * moved to Postgres; the semantics below did not, and must not.
 */

export { DRINK_COURSES, FOOD_COURSES };

/**
 * `Item.diet` means "suitable for this kind of diner", so a diner constraint is
 * normally a WIDENING. `nonveg` is the exception: the guest is asking for meat,
 * which NARROWS. Getting that backwards makes "1 non veg" return paneer tikka.
 *
 * `Eggetarian` is deliberately excluded from `veg` (in Indian usage egg is not
 * vegetarian). `Jain` is included in `veg` because Jain is strictly stricter,
 * but `veg` is never included in `jain`.
 */
const DIET_FILTERS: Record<string, Diet[] | null> = {
  veg: ["Vegetarian", "Jain"],
  jain: ["Jain"],
  egg: ["Vegetarian", "Jain", "Eggetarian"],
  fish: ["Vegetarian", "Jain", "Eggetarian", "OnlyFish"],
  nonveg: ["NonVegetarian", "OnlyFish"],
  any: null,
};

/** Bands overlap on purpose: with ~80 food items, disjoint bands strand slots. */
const SPICE_FILTERS: Record<string, { gte?: number; lte?: number } | null> = {
  none: { lte: 1 },
  mild: { gte: 1, lte: 2 },
  medium: { gte: 2, lte: 3 },
  spicy: { gte: 3 },
  very_spicy: { gte: 4 },
  any: null,
};

/** Midpoint of each band, for the spice-proximity term in menu.rank.ts. */
export const SPICE_TARGET: Record<string, number | null> = {
  none: 0,
  mild: 1.5,
  medium: 2.5,
  spicy: 4,
  very_spicy: 4.5,
  any: null,
};

/** Only orderable dishes reach a guest. The dashboard passes false. */
export const ORDERABLE: Prisma.ItemWhereInput = {
  isActive: true,
  isAvailable: true,
  soldOut: false,
};

export function buildWhere(
  slot: Slot,
  opts: { includeDrinks: boolean; orderableOnly?: boolean },
): Prisma.ItemWhereInput {
  const where: Prisma.ItemWhereInput = {};

  if (opts.orderableOnly !== false) Object.assign(where, ORDERABLE);

  const diets = DIET_FILTERS[slot.diet];
  if (diets && diets.length > 0) where.diet = { in: diets };

  const spice = SPICE_FILTERS[slot.spice];
  if (spice) where.spice = spice;

  if (slot.cuisine !== "any") where.cuisine = slot.cuisine;

  // A specific course wins; courseGroup only applies when none was stated.
  // An explicit allowlist (never a negation) so a future CourseEnum value fails
  // closed rather than leaking into every result.
  const courses = allowedCourses(slot, opts.includeDrinks);
  if (courses) where.course = { in: courses as never };

  return where;
}

/** Ordered rungs tried when a slot can't fill `perSlot`. Diet is never relaxed. */
export const RELAXATIONS = [
  "spice_widened",
  "cuisine_softened",
  "spice_dropped",
  "strength_widened",
  "strength_dropped",
  "style_dropped",
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
      // Drop the hard cuisine filter but remember what it was. This used to rely
      // on leaving the word in `searchText` so the embedding carried the
      // preference softly; with no embeddings, `softenedCuisine` is what keeps
      // it a preference instead of losing it -- menu.rank.ts still scores a
      // match higher. Same intent, deterministic implementation.
      if (slot.cuisine === "any") return null;
      return { ...slot, cuisine: "any", softenedCuisine: slot.cuisine };
    case "spice_dropped":
      if (slot.spice === "any") return null;
      return { ...slot, spice: "any" };
    case "strength_widened": {
      // "A strong cocktail" on a menu with one 30%+ cocktail should reach the
      // 28% martinis before it reaches a 16% spritz.
      const range = abvRange(slot);
      if (!range) return null;
      return {
        ...slot,
        strength: "any",
        abvMin: range.min > 0 ? Math.max(0.5, range.min - 10) : undefined,
        abvMax: range.max < 100 ? Math.min(100, range.max + 10) : undefined,
      };
    }
    case "strength_dropped":
      // Late on the ladder: once the % bounds go there is nothing left to rank
      // strength by, so a guest who asked for "strong" gets anything alcoholic.
      if ((slot.strength ?? "any") === "any" && slot.abvMin == null && slot.abvMax == null) return null;
      return { ...slot, strength: "any", abvMin: undefined, abvMax: undefined };
    case "style_dropped":
      // After strength: "a strong cocktail" should become "a cocktail" before it
      // becomes "anything strong" -- the noun is what they asked for.
      if (!slot.drinkStyle) return null;
      return { ...slot, drinkStyle: undefined };
    case "course_dropped":
      // Alcoholic vs non-alcoholic is a promise, like diet: someone who asked
      // for a mocktail must never be relaxed into a cocktail, and someone who
      // asked for a drink should not be handed a starter.
      if (slot.course === "Alcohol" || slot.course === "Beverage") return null;
      if (slot.course === "any" && slot.courseGroup === "any") return null;
      return { ...slot, course: "any", courseGroup: "any" };
  }
}

/**
 * Does an item's stored diet satisfy a slot's diet constraint?
 *
 * Used to re-check rows after retrieval. It was originally a guard against
 * stale Pinecone metadata, which no longer exists -- but it is now the guard
 * against a bug in the query layer itself, and it is the reason a classifier
 * that falls back to `diet: "any"` under low confidence is safe: nothing in the
 * pipeline ever *asserts* a dish suits a diet without this check passing. The
 * advisory path, where a model picks the dishes, needs it most of all.
 */
export function dietAllows(slotDiet: string, itemDiet: string): boolean {
  const allowed = DIET_FILTERS[slotDiet];
  return allowed == null ? true : (allowed as string[]).includes(itemDiet);
}

/**
 * Does an item's estimated strength satisfy a slot? Applied after SQL, since
 * ABV is derived from the name rather than stored (see src/domain/abv.ts).
 *
 * An Alcohol slot never accepts a 0% item -- the bar course also holds the
 * blending water and the shisha that the POS filed there.
 */
export function abvAllows(
  slot: Slot,
  abv: number | null,
  style: DrinkStyle | null = null,
): boolean {
  if (slot.course === "Alcohol" && !isAlcoholic(abv)) return false;
  if (slot.course === "Beverage" && isAlcoholic(abv)) return false;
  if (slot.drinkStyle && !styleMatches(slot.drinkStyle, style)) return false;
  const range = abvRange(slot);
  if (!range) return true;
  return abv != null && abv >= range.min && abv <= range.max;
}

function styleMatches(wanted: DrinkStyle, actual: DrinkStyle | null): boolean {
  if (actual == null) return false;
  if (wanted === "spirit") return SPIRIT_STYLES.includes(actual);
  // A cocktail request is happy with a shot; the reverse is not true.
  if (wanted === "cocktail") return actual === "cocktail" || actual === "shot";
  return actual === wanted;
}

/** The courses a slot is willing to accept, or null when unconstrained. */
export function allowedCourses(slot: Slot, includeDrinks: boolean): string[] | null {
  if (slot.course !== "any") return [slot.course];
  if (includeDrinks) return null;
  if (slot.courseGroup === "food") return [...FOOD_COURSES];
  if (slot.courseGroup === "drink") return [...DRINK_COURSES];
  return null;
}
