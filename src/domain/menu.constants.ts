/**
 * The one place the menu's closed vocabularies are written down.
 *
 * These strings are the Prisma enum values. They used to be spelled
 * `Vegeterian` / `Non_vegeterian`, and the misspelling was load-bearing: an LLM
 * told to emit those tokens "corrects" them a fair share of the time, so the
 * old parser answered in diner language and mapped here. Jev never emits an enum
 * token -- it picks a label from criteria we define -- so the spelling was fixed
 * and the indirection kept anyway, because diner language is what a guest types.
 */

export const DIETS = ["Vegetarian", "NonVegetarian", "Eggetarian", "OnlyFish", "Jain"] as const;
export type Diet = (typeof DIETS)[number];

export const CUISINES = ["Indian", "Asian", "Italian", "Continental", "Beverage", "Other"] as const;
export type Cuisine = (typeof CUISINES)[number];

export const COURSES = [
  "Starter", "MainCourse", "Bread", "Salad", "Dessert",
  "Beverage", "Alcohol", "Shisha", "Sides",
] as const;
export type Course = (typeof COURSES)[number];

export const PROTEINS = [
  "Chicken", "Mutton", "Fish", "Prawns", "Egg", "Paneer", "Tofu", "None",
] as const;
export type Protein = (typeof PROTEINS)[number];

export const FOOD_COURSES = ["Starter", "MainCourse", "Bread", "Salad", "Dessert", "Sides"] as const;
export const DRINK_COURSES = ["Beverage", "Alcohol", "Shisha"] as const;

export function isFoodCourse(course: string): boolean {
  return (FOOD_COURSES as readonly string[]).includes(course);
}

/** How a dish's diet reads on a card. `OnlyFish` is a column name, not a word. */
export const DIET_WORDS: Record<string, string> = {
  Vegetarian: "Vegetarian",
  NonVegetarian: "Non-vegetarian",
  Eggetarian: "Eggetarian",
  OnlyFish: "Pescatarian",
  Jain: "Jain",
};

export const SPICE_WORDS = [
  "not spicy", "very mild", "mild", "medium spicy", "hot", "very spicy",
] as const;

/**
 * Below this, the spice level was never assessed with confidence and must not
 * be stated as fact -- not in a card, not in an answer, not in the ranking.
 */
export const SPICE_MIN_CONFIDENCE = 0.5;

/**
 * POS merchandising tags that mean "people order this". `popularity` is their
 * count. It is a tiebreaker and nothing more: "Bestseller" sits on 78 of 435
 * items because somebody ticked a box, not because of sales data.
 */
export const POPULARITY_TAGS = [
  "bestseller", "trending", "fan-favourite", "chefs-special", "new",
] as const;

/** The closed taste vocabulary. Anything outside it is dropped, not invented. */
export const TASTE_TAGS = [
  "spicy", "sweet", "tangy", "smoky", "creamy", "crispy", "cheesy", "garlicky",
  "citrusy", "comforting", "refreshing", "rich", "light", "savoury", "nutty",
  "herby", "bitter", "fruity",
] as const;
