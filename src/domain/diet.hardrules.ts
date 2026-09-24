/**
 * Deterministic guards that outrank any classifier -- the heuristic seeder and
 * the LLM enrichment alike.
 *
 * Ported from rag/menu_rag/hardrules.py, which recorded why it exists:
 * ministral-8b is good at judging heat and taste but unreliable on the facts the
 * dish name states outright. Left alone it labelled "Hot Garlic Fish" and "Fish
 * Finger" as vegetarian, "Tandoori Royal Veg Platter" as non-vegetarian, and
 * filed "Steam Rice" under course Alcohol.
 *
 * A vegetarian being recommended fish is not a ranking miss, it is a broken
 * promise. Where the name is unambiguous, the name wins.
 */

import type { Course, Cuisine, Diet, Protein } from "./menu.constants.ts";

// Deliberately excludes "egg": egg is handled separately, and several
// vegetarian dishes mention it only when describing a batter.
const MEAT_RE =
  /\b(chicken|murgh|mutton|lamb|keema|tangdi|fish|prawn|shrimp|crab|bacon|ham|pepperoni|salami|meat|seekh)\b/i;
const NON_FISH_MEAT_RE =
  /\b(chicken|murgh|mutton|lamb|keema|tangdi|bacon|ham|pepperoni|salami|seekh)\b/i;
const FISH_ONLY_RE = /\b(fish|prawn|shrimp|crab)\b/i;
const EGG_RE = /\begg(s)?\b/i;
/** "(N-V)" and "Non Veg" mark a non-vegetarian variant of an otherwise veg dish. */
const NONVEG_MARK_RE = /non[\s_-]*veg|\(\s*n\s*-?\s*v\s*\)/i;
const VEG_MARK_RE = /\bveg\b|\bvegetarian\b|\(\s*veg\s*\)/i;

/**
 * Ingredients that make a dish vegetarian by definition.
 *
 * Added after the model filed "Paneer Tikka Masala" as non-vegetarian with
 * protein Prawns, from a source row that said VEG. Paneer is cottage cheese;
 * there is no judgement to make. A dish named after one of these, with no meat
 * word anywhere in its text, is vegetarian.
 */
const VEG_INGREDIENT_RE =
  /\b(paneer|tofu|paneer|mushroom|aloo|gobi|bhindi|baingan|chana|chole|rajma|dal|daal|makhani|malai kofta|palak|saag|corn|veggie|falafel|hummus)\b/i;

/** Which of the veg ingredients it is, so a wrong meat protein can be replaced. */
const VEG_PROTEIN_HINTS: [RegExp, Protein][] = [
  [/paneer|cottage cheese/i, "Paneer"],
  [/tofu/i, "Tofu"],
];

const DRINK_COURSES = new Set<string>(["Beverage", "Alcohol", "Shisha"]);

/** Used only to rescue a food dish that a classifier filed under a drink course. */
const COURSE_HINTS: [RegExp, Course][] = [
  [/\b(naan|roti|kulcha|paratha|bread|laccha)\b/i, "Bread"],
  [/\b(salad)\b/i, "Salad"],
  [/\b(cake|tiramisu|brownie|ice\s*cream|kulfi|dessert|pudding)\b/i, "Dessert"],
  [/\b(rice|pulao|biryani|curry|gravy|dal|makhni|steak|pasta|pizza|noodle)\b/i, "MainCourse"],
  [/\b(fries|platter|nachos|wings|pops|tikki|kebab|tikka|wonton|dimsum|bao)\b/i, "Starter"],
];

/**
 * Courses the dish name states as a fact rather than a judgement. Applied
 * unconditionally, because a model asked to categorise a menu will file most of
 * it under MainCourse and quietly empty the Bread and Dessert sections.
 */
const STRUCTURAL_COURSES: [RegExp, Course][] = [
  [/\b(naan|roti|kulcha|paratha|laccha|bread)\b/i, "Bread"],
  [/\b(cake|tiramisu|brownie|ice\s*cream|kulfi|dessert|pudding|cheesecake|gulab|jamun|halwa)\b/i, "Dessert"],
  [/\bsalad\b/i, "Salad"],
];

const INDIAN_HINT_RE =
  /\b(naan|roti|kulcha|dal|makhni|tikka|kebab|biryani|pulao|masala|paneer)\b/i;

const PROTEIN_HINTS: [RegExp, Protein][] = [
  [/chicken|murgh|tangdi/i, "Chicken"],
  [/mutton|lamb|keema|seekh/i, "Mutton"],
  [/prawn|shrimp/i, "Prawns"],
  [/fish|crab/i, "Fish"],
];

export type Classified = {
  cuisine: Cuisine;
  course: Course;
  diet: Diet;
  protein: Protein;
  spice: number;
  spiceConfidence: number | null;
};

export type HardRuleSource = {
  name: string;
  desc: string | null;
  /** The raw POS merchandising tag string, or the normalised tag list. */
  tags: string[];
};

/**
 * Returns `input` overridden wherever the source text is decisive. Pure, so the
 * three dishes named in the docstring above are unit-testable without a DB.
 */
export function applyHardRules(input: Classified, source: HardRuleSource): Classified {
  const text = `${source.name} ${source.desc ?? ""}`;
  const tags = source.tags.map((t) => t.toLowerCase());
  const out: Classified = { ...input };

  // 1. The POS tags are authoritative about what the thing IS.
  if (tags.includes("boozy")) {
    return { ...out, course: "Alcohol", cuisine: "Beverage", spice: 0, spiceConfidence: 1 };
  }
  if (tags.includes("lounge")) {
    return { ...out, course: "Shisha", cuisine: "Other", spice: 0, spiceConfidence: 1 };
  }

  // 2. Diet. Order matters: an explicit marker in the NAME is the strongest
  //    signal there is, and it must beat meat words found in a description.
  //    "Tandoori Royal Veg Platter" describes a "mushroom veg seekh kebab" --
  //    reading `seekh` as meat there turned a veg platter non-vegetarian.
  const hasMeatWord = MEAT_RE.test(text);

  if (NONVEG_MARK_RE.test(source.name)) {
    out.diet = "NonVegetarian";
  } else if (VEG_MARK_RE.test(source.name)) {
    out.diet = "Vegetarian";
    if (["Chicken", "Mutton", "Fish", "Prawns"].includes(out.protein)) out.protein = "None";
  } else if (!hasMeatWord && (VEG_INGREDIENT_RE.test(text) || tags.includes("veg"))) {
    // Two facts nothing should be allowed to override: a paneer dish is
    // vegetarian, and a POS row tagged "Veg" whose text names no meat is
    // vegetarian. The tag is only trusted in this direction -- meat dishes are
    // often mis-tagged "Veg", but they always name their meat, so `hasMeatWord`
    // has already ruled them out by the time we get here.
    //
    // Egg still has to be checked first. MEAT_RE deliberately excludes it, so
    // "Gochujang Devilled Eggs" reaches this branch and would otherwise be
    // downgraded from Eggetarian to Vegetarian -- which is exactly the direction
    // that misleads a vegetarian diner.
    out.diet = EGG_RE.test(text) ? "Eggetarian" : "Vegetarian";
    if (["Chicken", "Mutton", "Fish", "Prawns"].includes(out.protein)) {
      out.protein = VEG_PROTEIN_HINTS.find(([re]) => re.test(text))?.[1] ?? "None";
    }
  } else if (hasMeatWord) {
    const onlyFish = FISH_ONLY_RE.test(text) && !NON_FISH_MEAT_RE.test(text);
    out.diet = onlyFish ? "OnlyFish" : "NonVegetarian";
    if (out.protein === "None") {
      for (const [pattern, protein] of PROTEIN_HINTS) {
        if (pattern.test(text)) {
          out.protein = protein;
          break;
        }
      }
    }
  } else if (EGG_RE.test(text) && out.diet === "Vegetarian") {
    out.diet = "Eggetarian";
  }

  // 3. A dish with no drink tag does not belong in a drink course.
  if (DRINK_COURSES.has(out.course)) {
    for (const [pattern, course] of COURSE_HINTS) {
      if (pattern.test(source.name)) {
        out.course = course;
        if (out.cuisine === "Beverage") {
          out.cuisine = INDIAN_HINT_RE.test(source.name) ? "Indian" : "Other";
        }
        break;
      }
    }
  }

  // 4. Bread, dessert and salad are structural facts the name states outright:
  //    a naan IS bread. Left to itself the model files almost everything under
  //    MainCourse, which empties the Bread and Dessert sections of the menu page.
  //    Starter vs MainCourse is a genuine judgement call, so it is NOT forced
  //    here -- the classifier keeps that one.
  for (const [pattern, course] of STRUCTURAL_COURSES) {
    if (pattern.test(source.name)) {
      out.course = course;
      break;
    }
  }

  return out;
}
