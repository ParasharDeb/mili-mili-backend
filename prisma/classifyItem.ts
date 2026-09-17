// Heuristic classifier that fills in fields data.json doesn't have (cuisine, course,
// protein, spice, taste tags, serves) by pattern-matching on name/description/allergens.
// Best-effort: the source POS export (petpooja) never captured these attributes.

export type SourceItem = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  dietary_type: "VEG" | "NON_VEG" | null;
  allergens: string | null;
};

const ALCOHOL_RE =
  /\b(whisky|whiskey|vodka|\bgin\b|\brum\b|tequila|wine|beer|champagne|cognac|brandy|liqueur|absinthe|sambuca|prosecco|proseco|martini|highball|shiraz|cabernet|pinot|merlot|chardonn?ay|rose|rioja|lambrusco|tempranilo|sangiovese|malt|bourbon|scotch)\b/i;
const VOL_RE = /\(\s*\d+\s*ml\s*\)|\(\s*btl\s*\)|\bbtl\b|\d+\s*ml\b|\d+\s*ltr\b/i;
const JW_RE = /^j\.?\s?w\.?\s/i;
const ALCOHOL_NAME_OVERRIDE = new Set(["samsara"]);

type Bucket = "Alcohol" | "Shisha" | "Beverage" | "Food";

function detectBucket(item: SourceItem): Bucket {
  const name = item.name || "";
  const tags = (item.allergens || "").toLowerCase();
  if (tags.includes("boozy")) return "Alcohol";
  if (ALCOHOL_NAME_OVERRIDE.has(name.trim().toLowerCase())) return "Alcohol";
  if (ALCOHOL_RE.test(name) || JW_RE.test(name) || (VOL_RE.test(name) && item.price !== 1351)) return "Alcohol";
  if (tags.includes("lounge")) return "Shisha";
  if (item.price === 1351 && !item.allergens) return "Shisha";
  if (/\bgum\b|\bpaan\b|spring\s*water|shisha|hookah/i.test(name)) return "Shisha";
  if (
    /juice|\bsoda\b|\bwater\b|rasna|mojito|\bvirgin\b|lemonade|thums up|\bcoke\b|sprite|ginger ale|tonic|milk\s*shake|smoothie/i.test(
      name,
    )
  )
    return "Beverage";
  return "Food";
}

const CuisineEnum = ["Indian", "Asian", "Italian", "Continental", "Beverage", "Other"] as const;
export type Cuisine = (typeof CuisineEnum)[number];

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

const CourseEnum = ["Starter", "MainCourse", "Bread", "Salad", "Dessert", "Beverage", "Alcohol", "Shisha", "Sides"] as const;
export type Course = (typeof CourseEnum)[number];

function detectCourse(bucket: Bucket, item: SourceItem): Course {
  if (bucket === "Alcohol") return "Alcohol";
  if (bucket === "Beverage") return "Beverage";
  if (bucket === "Shisha") return "Shisha";
  const t = `${item.name} ${item.description || ""}`.toLowerCase();
  if (/\bnaan\b|\broti\b|kulcha/.test(t)) return "Bread";
  if (/\bcake\b|cheesecake|tiramisu/.test(t)) return "Dessert";
  if (/salad/.test(t)) return "Salad";
  if (/platter|papad|poppadom|onion rings|nachos|\bfries\b/.test(t)) return "Sides";
  if (/curry|masala|gravy|dal makhni|pasta|spaghetti|penne|pizza|pulao|\brice\b|noodle|fondue/.test(t)) return "MainCourse";
  return "Starter";
}

const ProteinEnum = ["Chicken", "Mutton", "Fish", "Prawns", "Egg", "Paneer", "Tofu", "None"] as const;
export type Protein = (typeof ProteinEnum)[number];

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

const DietPrefEnum = ["Vegeterian", "Non_vegeterian", "Eggeterian", "OnlyFish", "Jain"] as const;
export type DietPref = (typeof DietPrefEnum)[number];

function detectDiet(item: SourceItem, protein: Protein): DietPref {
  if (item.dietary_type === "VEG") return "Vegeterian";
  if (item.dietary_type === "NON_VEG") return "Non_vegeterian";
  const tags = (item.allergens || "").toLowerCase();
  if (tags.includes("veg") && !tags.includes("non veg") && !tags.includes("non_veg")) return "Vegeterian";
  if (protein === "Egg") return "Eggeterian";
  if (["Chicken", "Mutton", "Fish", "Prawns"].includes(protein)) return "Non_vegeterian";
  return "Vegeterian";
}

function detectSpice(item: SourceItem, bucket: Bucket, course: Course): number {
  if (bucket !== "Food" || course === "Bread" || course === "Dessert" || course === "Salad") return 0;
  const t = `${item.name} ${item.description || ""}`.toLowerCase();
  const tags = (item.allergens || "").toLowerCase();
  let s = 0;
  if (tags.includes("spicy")) s += 3;
  if (/chilli|chili/.test(t)) s += 1;
  if (/peri\s*peri|schezwan|szechwan|devilled/.test(t)) s += 1;
  if (/tandoori/.test(t)) s += 1;
  if (/mild/.test(t)) s -= 2;
  return Math.max(0, Math.min(5, s));
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

function detectTasteTags(item: SourceItem): string[] {
  const t = `${item.name} ${item.description || ""}`.toLowerCase();
  const tags = (item.allergens || "").split(",").map((s) => s.trim().toLowerCase());
  const out = new Set<string>();
  for (const tag of tags) if (TAG_MAP[tag]) out.add(TAG_MAP[tag]!);
  if (/smok|bbq|charcoal|grilled/.test(t)) out.add("smoky");
  if (/tangy|tamarind|chilli mustard/.test(t)) out.add("tangy");
  if (/\bgarlic\b/.test(t)) out.add("garlicky");
  if (/\bhoney\b/.test(t)) out.add("sweet");
  if (/\bcitrus|\blime\b|\borange\b|\blemon\b/.test(t)) out.add("citrusy");
  return [...out];
}

function detectServes(item: SourceItem): number[] {
  const name = item.name.toLowerCase();
  if (/\bbtl\b|\(btl\)/.test(name)) return [4, 6];
  if (/platter/.test(name)) return [2, 3, 4];
  if (/\d+\s*ltr\b/.test(name)) return [6, 8, 10];
  return [1];
}

export type ClassifiedItem = {
  id: string;
  name: string;
  desc: string | null;
  cuisine: Cuisine;
  course: Course;
  diet: DietPref;
  allergens: string | null;
  protein: Protein;
  spice: number;
  tasteTags: string[];
  serves: number[];
};

export function classifyItem(item: SourceItem): ClassifiedItem {
  const bucket = detectBucket(item);
  const cuisine = detectCuisine(bucket, item);
  const course = detectCourse(bucket, item);
  const protein = detectProtein(item);
  const diet = detectDiet(item, protein);
  const spice = detectSpice(item, bucket, course);
  const tasteTags = detectTasteTags(item);
  const serves = detectServes(item);

  return {
    id: item.id,
    name: item.name,
    desc: item.description,
    cuisine,
    course,
    diet,
    allergens: item.allergens,
    protein,
    spice,
    tasteTags,
    serves,
  };
}
