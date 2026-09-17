import { chatJson } from "../lib/mistral.ts";
import { slotPlanSchema, type Slot, type SlotPlan } from "../schemas/menu.schema.ts";

/** Turns a guest's sentence into structured slots. */

const SYSTEM_PROMPT = `You convert a restaurant guest's request into "slots". Return JSON only.

A slot is ONE distinct constraint the guest actually stated.

Schema:
{"partySize": <int>, "slots": [{
  "label": "<2-5 word echo, e.g. 2 vegetarian>",
  "count": <how many guests this covers, default 1>,
  "diet": "veg" | "nonveg" | "egg" | "fish" | "jain" | "any",
  "spice": "none" | "mild" | "medium" | "spicy" | "very_spicy" | "any",
  "cuisine": "Indian" | "Asian" | "Italian" | "Continental" | "Beverage" | "Other" | "any",
  "course": "Starter" | "MainCourse" | "Bread" | "Salad" | "Dessert" | "Beverage" | "Alcohol" | "Shisha" | "Sides" | "any",
  "courseGroup": "food" | "drink" | "any",
  "searchText": "<short natural dish description, max 15 words>"
}]}

RULES
1. One slot per constraint the guest stated. Never invent a slot to pad the party size.
2. If the guest did not mention a dimension, use "any". Never guess.
3. courseGroup is "food" unless the guest explicitly asked for drinks, cocktails,
   wine, beer, mocktails or shisha, in which case "drink".
4. searchText describes the dish the way a diner would. Never mention JSON or filters.
5. If the guest is ASKING ABOUT a dish rather than asking you to suggest one --
   "what is in X", "is X spicy", "does X have nuts", "tell me about X" -- that is a
   question, not a constraint. Return {"partySize":0,"slots":[]} for those.

EXAMPLE
Guest: "recommendations for 5 people. 2 veg, 1 non veg not spicy, 1 non veg spicy and one italian"
{"partySize":5,"slots":[
{"label":"2 vegetarian","count":2,"diet":"veg","spice":"any","cuisine":"any","course":"any","courseGroup":"food","searchText":"vegetarian dish to share"},
{"label":"1 non-veg, mild","count":1,"diet":"nonveg","spice":"none","cuisine":"any","course":"any","courseGroup":"food","searchText":"non-vegetarian dish that is not spicy"},
{"label":"1 non-veg, spicy","count":1,"diet":"nonveg","spice":"spicy","cuisine":"any","course":"any","courseGroup":"food","searchText":"spicy non-vegetarian dish"},
{"label":"1 Italian","count":1,"diet":"any","spice":"any","cuisine":"Italian","course":"any","courseGroup":"food","searchText":"italian pasta or pizza"}]}

EXAMPLE
Guest: "what is in the butter naan?"
{"partySize":0,"slots":[]}

EXAMPLE
Guest: "what should we order for four?"
{"partySize":4,"slots":[
{"label":"4 guests","count":4,"diet":"any","spice":"any","cuisine":"any","course":"any","courseGroup":"food","searchText":"popular dish to share"}]}

EXAMPLE
Guest: "table for 3, one jain, and a couple of cocktails"
{"partySize":3,"slots":[
{"label":"1 Jain","count":1,"diet":"jain","spice":"any","cuisine":"any","course":"any","courseGroup":"food","searchText":"jain dish without onion or garlic"},
{"label":"2 cocktails","count":2,"diet":"any","spice":"any","cuisine":"any","course":"Alcohol","courseGroup":"drink","searchText":"cocktail"}]}`;

// Models get the concept right and the token wrong. Normalise before validating.
const DIET_ALIASES: Record<string, string> = {
  vegetarian: "veg", pureveg: "veg", veggie: "veg", vegan: "veg",
  nonvegetarian: "nonveg", nonveg: "nonveg", meat: "nonveg", chicken: "nonveg",
  eggetarian: "egg", eggitarian: "egg",
  pescatarian: "fish", seafood: "fish", onlyfish: "fish",
  jainfood: "jain",
};
const SPICE_ALIASES: Record<string, string> = {
  notspicy: "none", nonspicy: "none", bland: "none", no: "none", "0": "none", "1": "none",
  light: "mild", "2": "mild",
  moderate: "medium", "3": "medium",
  hot: "spicy", "4": "spicy",
  extraspicy: "very_spicy", veryhot: "very_spicy", "5": "very_spicy",
};
const CUISINE_ALIASES: Record<string, string> = {
  italian: "Italian", italy: "Italian",
  chinese: "Asian", thai: "Asian", japanese: "Asian", oriental: "Asian", asian: "Asian",
  indian: "Indian", northindian: "Indian", desi: "Indian", punjabi: "Indian",
  continental: "Continental", european: "Continental", western: "Continental", american: "Continental",
};
const COURSE_ALIASES: Record<string, string> = {
  main: "MainCourse", maincourse: "MainCourse", maindish: "MainCourse", entree: "MainCourse",
  starter: "Starter", appetiser: "Starter", appetizer: "Starter", snack: "Starter",
  side: "Sides", sides: "Sides", bread: "Bread", dessert: "Dessert", salad: "Salad",
  drink: "Beverage", beverage: "Beverage", mocktail: "Beverage", juice: "Beverage",
  cocktail: "Alcohol", wine: "Alcohol", beer: "Alcohol", alcohol: "Alcohol", liquor: "Alcohol",
  shisha: "Shisha", hookah: "Shisha",
};

const DIETS = ["veg", "nonveg", "egg", "fish", "jain", "any"];
const SPICES = ["none", "mild", "medium", "spicy", "very_spicy", "any"];
const CUISINES = ["Indian", "Asian", "Italian", "Continental", "Beverage", "Other", "any"];
const COURSES = ["Starter", "MainCourse", "Bread", "Salad", "Dessert",
  "Beverage", "Alcohol", "Shisha", "Sides", "any"];

const DRINK_COURSE_VALUES = ["Beverage", "Alcohol", "Shisha"];

const key = (v: unknown) => String(v ?? "").toLowerCase().replace(/[\s_-]/g, "");

function pick(value: unknown, aliases: Record<string, string>, allowed: string[]): string {
  const raw = String(value ?? "").trim();
  const exact = allowed.find((a) => a.toLowerCase() === raw.toLowerCase());
  if (exact) return exact;
  const mapped = aliases[key(raw)];
  return mapped && allowed.includes(mapped) ? mapped : "any";
}

function normalize(raw: any): unknown {
  const slots = Array.isArray(raw?.slots) ? raw.slots : [];
  return {
    partySize: Number(raw?.partySize) || 0,
    slots: slots.map((s: any) => {
      const course = pick(s?.course, COURSE_ALIASES, COURSES);
      const rawGroup = key(s?.courseGroup);
      const group = ["food", "drink", "any"].includes(rawGroup) ? rawGroup : "food";
      return {
        label: String(s?.label ?? "Anything").slice(0, 60) || "Anything",
        count: Math.max(1, Math.min(50, Number(s?.count) || 1)),
        diet: pick(s?.diet, DIET_ALIASES, DIETS),
        spice: pick(s?.spice, SPICE_ALIASES, SPICES),
        cuisine: pick(s?.cuisine, CUISINE_ALIASES, CUISINES),
        course,
        // A drink course implies a drink slot even if the model said otherwise.
        courseGroup: DRINK_COURSE_VALUES.includes(course) ? "drink" : group,
        searchText: String(s?.searchText || s?.label || "dish").slice(0, 160),
      };
    }),
  };
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, couple: 2,
};

/**
 * No-LLM parser. Covers the common "N veg, N non veg spicy" phrasing so the
 * endpoint still answers during a Mistral outage, and doubles as the offline
 * test oracle for the filter mapping.
 */
export function heuristicParse(query: string): SlotPlan {
  const text = query.toLowerCase();
  const digitParty = /for\s+(\d+)\s*(?:people|pax|guests|persons)/.exec(text)?.[1];
  const wordParty = /for\s+([a-z]+)\s*(?:people|pax|guests|persons)/.exec(text)?.[1];
  const partySize = Number(digitParty) || NUMBER_WORDS[wordParty ?? ""] || 0;

  // Drop the party-size phrase before splitting, or "for 5 people. 2 veg"
  // reads the 5 as the first slot's count instead of the 2.
  const body = text.replace(/\bfor\s+\S+\s*(?:people|pax|guests|persons)/g, " ");

  const slots: Slot[] = [];

  // Full stops separate constraints as often as commas do.
  for (const chunk of body.split(/[,.;]|\band\b|\bplus\b|&/)) {
    const c = chunk.trim();
    if (!c) continue;

    const digit = /(\d+)/.exec(c)?.[1];
    const word = Object.keys(NUMBER_WORDS).find((w) => new RegExp("\\b" + w + "\\b").test(c));
    const count = Math.max(1, Number(digit) || NUMBER_WORDS[word ?? ""] || 1);

    const isNonVeg = /non[\s-]*veg/.test(c);
    const diet = isNonVeg ? "nonveg"
      : /\bjain\b/.test(c) ? "jain"
      : /\begg/.test(c) ? "egg"
      : /\bfish\b|seafood|pescatarian/.test(c) ? "fish"
      : /\bveg\b|vegetarian/.test(c) ? "veg"
      : "any";

    const spice = /not\s*spicy|non[\s-]*spicy|no\s*spice|bland|mild/.test(c) ? "none"
      : /very\s*spicy|extra\s*spicy/.test(c) ? "very_spicy"
      : /spicy|\bhot\b/.test(c) ? "spicy"
      : "any";

    const cuisineWord = Object.keys(CUISINE_ALIASES)
      .find((w) => new RegExp("\\b" + w + "\\b").test(c));
    const cuisine = cuisineWord ? CUISINE_ALIASES[cuisineWord]! : "any";

    const isDrink = /cocktail|drink|wine|beer|mocktail|juice|shisha|hookah/.test(c);

    // A chunk that states nothing ("i need recommendations") is not a slot.
    if (diet === "any" && spice === "any" && cuisine === "any" && !isDrink) continue;

    const labelBits = [
      String(count),
      diet === "nonveg" ? "non-veg" : diet !== "any" ? diet : "",
      spice === "none" ? "mild" : spice !== "any" ? spice.replace("_", " ") : "",
      cuisine !== "any" ? cuisine : "",
    ].filter(Boolean);

    const searchBits = [
      spice === "none" ? "mild not spicy" : spice !== "any" ? spice.replace("_", " ") : "",
      cuisine !== "any" ? cuisine : "",
      diet === "nonveg" ? "non-vegetarian" : diet !== "any" ? diet : "",
      isDrink ? "cocktail" : "dish",
      count > 1 ? "to share" : "",
    ].filter(Boolean);

    slots.push({
      label: labelBits.join(" ").trim() || "Anything",
      count,
      diet: diet as Slot["diet"],
      spice: spice as Slot["spice"],
      cuisine: cuisine as Slot["cuisine"],
      course: isDrink ? "Alcohol" : "any",
      courseGroup: isDrink ? "drink" : "food",
      searchText: searchBits.join(" "),
    });
  }

  return { partySize, slots };
}

export async function parseQuery(
  query: string,
): Promise<{ plan: SlotPlan; mode: "llm" | "heuristic" }> {
  try {
    const raw = await chatJson([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: query },
    ]);
    const parsed = slotPlanSchema.safeParse(normalize(raw));
    if (parsed.success) return { plan: parsed.data, mode: "llm" };
  } catch {
    // fall through to the offline parser
  }

  return { plan: heuristicParse(query), mode: "heuristic" };
}
