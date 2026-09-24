// Heuristic classifier that fills in what the POS export never captured
// (cuisine, course, protein, spice, taste tags, portions) by pattern-matching on
// name/description/tags, and normalises the fields it DOES carry.
//
// Best effort, and honest about it: `spiceConfidence` is only set where a rule
// fired on an explicit signal. Everywhere else it stays null, which the UI and
// the ranker both read as "never assessed" rather than "confidently zero".
// `prisma/enrich.ts` fills those in afterwards.

import { applyHardRules } from "../src/domain/diet.hardrules.ts";
import {
  POPULARITY_TAGS,
  type Course,
  type Cuisine,
  type Diet,
  type Protein,
} from "../src/domain/menu.constants.ts";

export type SourceItem = {
  id: string;
  name: string;
  description: string | null;
  price: number | string;
  dietary_type: "VEG" | "NON_VEG" | null;
  /** Misnamed at source: this is a merchandising tag string, not allergens. */
  allergens: string | null;
  available?: boolean | null;
  sold_out?: boolean | null;
  active?: boolean | null;
  image_url?: string | null;
  category_id?: string | null;
  sort?: number | null;
  source?: string | null;
  external_ref?: string | null;
};

/* ------------------------------------------------------------------ tags -- */

/** The POS tag vocabulary as of the current export. Anything else is reported. */
const KNOWN_TAGS = new Set([
  "veg", "boozy", "bar", "trending", "bestseller", "new", "fan-favourite",
  "chefs-special", "lounge", "protein", "refreshing", "tandoori", "cheesy",
  "crispy", "snack", "spicy", "platter", "comfort", "sweet", "dessert",
]);

const seenUnknownTags = new Set<string>();

function kebab(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * "Boozy, Bar, Veg, Trending" -> ["boozy","bar","veg","trending"].
 *
 * Unknown tokens are kept -- dropping data silently is how a menu quietly loses
 * a category -- but reported once each, because the next POS export will invent
 * new ones and nobody will think to look.
 */
export function normalizeTags(raw: string | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const tag = kebab(part);
    if (!tag) continue;
    if (!KNOWN_TAGS.has(tag) && !seenUnknownTags.has(tag)) {
      seenUnknownTags.add(tag);
      console.warn(`[classify] unrecognised POS tag "${tag}" (from "${part.trim()}")`);
    }
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

/** Count of the "people order this" tags. A tiebreaker, never a ranking driver. */
export function derivePopularity(tags: string[]): number {
  return (POPULARITY_TAGS as readonly string[]).filter((t) => tags.includes(t)).length;
}

/* -------------------------------------------------------------- buckets -- */

const ALCOHOL_RE =
  /\b(whisky|whiskey|vodka|\bgin\b|\brum\b|tequila|wine|beer|champagne|cognac|brandy|liqueur|absinthe|sambuca|prosecco|proseco|martini|highball|shiraz|cabernet|pinot|merlot|chardonn?ay|rose|rioja|lambrusco|tempranilo|sangiovese|malt|bourbon|scotch)\b/i;
const VOL_RE = /\(\s*\d+\s*ml\s*\)|\(\s*btl\s*\)|\bbtl\b|\d+\s*ml\b|\d+\s*ltr\b/i;
const JW_RE = /^j\.?\s?w\.?\s/i;
const ALCOHOL_NAME_OVERRIDE = new Set(["samsara"]);

type Bucket = "Alcohol" | "Shisha" | "Beverage" | "Food";

function detectBucket(item: SourceItem, tags: string[], price: number): Bucket {
  const name = item.name || "";
  if (tags.includes("boozy")) return "Alcohol";
  if (ALCOHOL_NAME_OVERRIDE.has(name.trim().toLowerCase())) return "Alcohol";
  if (ALCOHOL_RE.test(name) || JW_RE.test(name) || (VOL_RE.test(name) && price !== 1351)) {
    return "Alcohol";
  }
  if (tags.includes("lounge")) return "Shisha";
  if (price === 1351 && tags.length === 0) return "Shisha";
  if (/\bgum\b|\bpaan\b|spring\s*water|shisha|hookah/i.test(name)) return "Shisha";
  if (
    /juice|\bsoda\b|\bwater\b|rasna|mojito|\bvirgin\b|lemonade|thums up|\bcoke\b|sprite|ginger ale|tonic|milk\s*shake|smoothie/i.test(
      name,
    )
  ) {
    return "Beverage";
  }
  return "Food";
}

function detectCuisine(bucket: Bucket, item: SourceItem): Cuisine {
  if (bucket !== "Food") return bucket === "Shisha" ? "Other" : "Beverage";
  const t = `${item.name} ${item.description || ""}`.toLowerCase();
  if (/pizza|pasta|spaghetti|penne|tiramisu|aglio|margherita/.test(t)) return "Italian";
  if (/dimsum|\bbao\b|\bwok\b|teriyaki|schezwan|szechwan|noodle|wonton|gochujang/.test(t)) return "Asian";
  if (/tandoori|kebab|curry|\bdal\b|paneer|\bnaan\b|\broti\b|kulcha|biryani|pulao|masala|tikka|\bsaag\b|bhaji|papad|makai/.test(t))
    return "Indian";
  if (/salad|cheesecake|nachos|\bfries\b|sandwich|steak|\bcake\b|wings|fondue|onion rings|fish finger|cheese ball/.test(t))
    return "Continental";
  return "Other";
}

function detectCourse(bucket: Bucket, item: SourceItem): Course {
  if (bucket === "Alcohol") return "Alcohol";
  if (bucket === "Beverage") return "Beverage";
  if (bucket === "Shisha") return "Shisha";
  const t = `${item.name} ${item.description || ""}`.toLowerCase();
  if (/\bnaan\b|\broti\b|kulcha/.test(t)) return "Bread";
  if (/\bcake\b|cheesecake|tiramisu/.test(t)) return "Dessert";
  if (/salad/.test(t)) return "Salad";
  if (/platter|papad|poppadom|onion rings|nachos|\bfries\b/.test(t)) return "Sides";
  if (/curry|masala|gravy|dal makhni|pasta|spaghetti|penne|pizza|pulao|\brice\b|noodle|fondue/.test(t))
    return "MainCourse";
  return "Starter";
}

function detectProtein(item: SourceItem): Protein {
  const t = `${item.name} ${item.description || ""}`.toLowerCase();
  if (/chicken/.test(t)) return "Chicken";
  if (/mutton|lamb/.test(t)) return "Mutton";
  if (/\bfish\b/.test(t)) return "Fish";
  if (/prawn|shrimp/.test(t)) return "Prawns";
  if (/\begg\b|eggs\b/.test(t)) return "Egg";
  if (/paneer|cottage cheese/.test(t)) return "Paneer";
  if (/\btofu\b/.test(t)) return "Tofu";
  return "None";
}

function detectDiet(item: SourceItem, tags: string[], protein: Protein): Diet {
  if (item.dietary_type === "VEG") return "Vegetarian";
  if (item.dietary_type === "NON_VEG") return "NonVegetarian";
  if (tags.includes("veg")) return "Vegetarian";
  if (protein === "Egg") return "Eggetarian";
  if (["Chicken", "Mutton", "Fish", "Prawns"].includes(protein)) return "NonVegetarian";
  return "Vegetarian";
}

/**
 * Returns the level AND whether anything actually justified it.
 *
 * The old version returned a bare 0 for 421 of 435 dishes, which nothing
 * downstream could tell apart from a confident "not spicy". Now an unsupported
 * guess reports null confidence, and `prisma/enrich.ts` replaces it.
 */
function detectSpice(
  item: SourceItem,
  tags: string[],
  bucket: Bucket,
  course: Course,
): { spice: number; confidence: number | null } {
  if (bucket !== "Food") return { spice: 0, confidence: 1 };
  if (course === "Bread" || course === "Dessert" || course === "Salad") {
    return { spice: 0, confidence: 0.8 };
  }

  const t = `${item.name} ${item.description || ""}`.toLowerCase();
  let s = 0;
  let evidence = 0;

  if (tags.includes("spicy")) { s += 3; evidence++; }
  if (/chilli|chili/.test(t)) { s += 1; evidence++; }
  if (/peri\s*peri|schezwan|szechwan|devilled/.test(t)) { s += 1; evidence++; }
  if (/tandoori/.test(t)) { s += 1; evidence++; }
  if (/\bmild\b/.test(t)) { s -= 2; evidence++; }

  return {
    spice: Math.max(0, Math.min(5, s)),
    // No signal at all means nobody has assessed this dish. Say so.
    confidence: evidence === 0 ? null : Math.min(1, 0.5 + 0.15 * evidence),
  };
}

const TAG_MAP: Record<string, string> = {
  spicy: "spicy",
  sweet: "sweet",
  cheesy: "cheesy",
  crispy: "crispy",
  tandoori: "smoky",
  refreshing: "refreshing",
  comfort: "comforting",
};

function detectTasteTags(item: SourceItem, tags: string[]): string[] {
  const t = `${item.name} ${item.description || ""}`.toLowerCase();
  const out = new Set<string>();
  for (const tag of tags) if (TAG_MAP[tag]) out.add(TAG_MAP[tag]!);
  if (/smok|bbq|charcoal|grilled/.test(t)) out.add("smoky");
  if (/tangy|tamarind|chilli mustard/.test(t)) out.add("tangy");
  if (/\bgarlic\b/.test(t)) out.add("garlicky");
  if (/\bhoney\b/.test(t)) out.add("sweet");
  if (/\bcitrus|\blime\b|\borange\b|\blemon\b/.test(t)) out.add("citrusy");
  return [...out];
}

/** Two ints, not an array: "we're 6, what's shareable" has to be a WHERE clause. */
function detectServes(item: SourceItem): { min: number; max: number } {
  const name = item.name.toLowerCase();
  if (/\bbtl\b|\(btl\)/.test(name)) return { min: 4, max: 6 };
  if (/platter/.test(name)) return { min: 2, max: 4 };
  if (/\d+\s*ltr\b/.test(name)) return { min: 6, max: 10 };
  return { min: 1, max: 1 };
}

/**
 * A base64 data URI in `image_url` would be read back on every menu page load,
 * because Prisma selects all scalar fields by default. 342 of 435 rows carry one
 * and they run to 135 KB each. The seeder writes those blobs to disk and stores
 * a path; everything else is passed through untouched.
 */
export function isInlineImage(url: string | null | undefined): boolean {
  return typeof url === "string" && url.startsWith("data:");
}

/* ------------------------------------------------------------ classify -- */

export type ClassifiedItem = {
  id: string;
  name: string;
  desc: string | null;
  price: string;
  cuisine: Cuisine;
  course: Course;
  diet: Diet;
  protein: Protein;
  spice: number;
  spiceConfidence: number | null;
  derivedFrom: "heuristic";
  derivedAt: Date;
  tasteTags: string[];
  tags: string[];
  popularity: number;
  allergens: string[];
  allergensVerified: boolean;
  servesMin: number;
  servesMax: number;
  isActive: boolean;
  isAvailable: boolean;
  soldOut: boolean;
  imageUrl: string | null;
  categoryRef: string | null;
  sortOrder: number;
  source: string;
  externalRef: string | null;
};

export function classifyItem(item: SourceItem): ClassifiedItem {
  const tags = normalizeTags(item.allergens);
  const price = Number(item.price) || 0;

  const bucket = detectBucket(item, tags, price);
  const course = detectCourse(bucket, item);
  const protein = detectProtein(item);
  const spice = detectSpice(item, tags, bucket, course);

  // The hard rules get the last word on anything the dish name states outright.
  const ruled = applyHardRules(
    {
      cuisine: detectCuisine(bucket, item),
      course,
      diet: detectDiet(item, tags, protein),
      protein,
      spice: spice.spice,
      spiceConfidence: spice.confidence,
    },
    { name: item.name, desc: item.description, tags },
  );

  const serves = detectServes(item);

  return {
    id: item.id,
    name: item.name,
    desc: item.description,
    // A string, not a float: Prisma parses it straight into Decimal without a
    // round trip through IEEE-754, so 421.00 stays 421.00.
    price: price.toFixed(2),
    cuisine: ruled.cuisine,
    course: ruled.course,
    diet: ruled.diet,
    protein: ruled.protein,
    spice: ruled.spice,
    spiceConfidence: ruled.spiceConfidence,
    derivedFrom: "heuristic",
    derivedAt: new Date(),
    tasteTags: detectTasteTags(item, tags),
    tags,
    popularity: derivePopularity(tags),
    // The POS `allergens` column is merchandising copy. Presenting it as an
    // allergen list is a safety claim nobody has verified, so we start empty.
    allergens: [],
    allergensVerified: false,
    servesMin: serves.min,
    servesMax: serves.max,
    isActive: item.active ?? true,
    isAvailable: item.available ?? true,
    soldOut: item.sold_out ?? false,
    imageUrl: isInlineImage(item.image_url) ? null : (item.image_url ?? null),
    categoryRef: item.category_id ?? null,
    sortOrder: item.sort ?? 0,
    source: item.source ?? "manual",
    externalRef: item.external_ref ?? null,
  };
}
