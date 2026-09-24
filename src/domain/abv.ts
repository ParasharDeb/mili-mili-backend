/**
 * Alcohol by volume, estimated from what a drink IS.
 *
 * The POS export carries no ABV at all, so this is a reading of the name and
 * description -- the same kind of best-effort classification as
 * prisma/classifyItem.ts, and honest about it: every value is a typical figure
 * for the style (a London dry gin is ~40%, a wheat beer ~5%), and the UI shows
 * it as "~40% ABV". Where a bottle's label is known to differ from its style,
 * the brand list below overrides.
 *
 * Pure, so the whole bar can be checked without a database.
 */

/** Strength bands a guest can ask for, in % ABV. Bands overlap on purpose. */
export const STRENGTH_BANDS = {
  light: { min: 0.5, max: 15 },
  medium: { min: 12, max: 30 },
  strong: { min: 30, max: 100 },
} as const;
export type Strength = keyof typeof STRENGTH_BANDS | "any";

/**
 * What kind of drink it is. Guests ask by kind ("a beer", "a strong cocktail",
 * "whisky above 42%") as often as by strength, and a % alone cannot tell a
 * 40% whisky from a 40% rum.
 */
export const DRINK_STYLES = [
  "beer", "wine", "cocktail", "shot", "liqueur",
  "whisky", "vodka", "gin", "rum", "tequila", "brandy", "spirit", "none",
] as const;
export type DrinkStyle = (typeof DRINK_STYLES)[number];

/** Styles that are a bottle of one spirit, for "spirits" or a bare "strong drink". */
export const SPIRIT_STYLES: readonly DrinkStyle[] = ["whisky", "vodka", "gin", "rum", "tequila", "brandy", "spirit"];

type Rule = [RegExp, number, DrinkStyle];

/** Brand or name fragments whose ABV is not the style default. Checked first. */
const BRANDS: Rule[] = [
  // Not alcoholic at all, despite sitting in the bar course.
  [/\bwater\b|springwater|\bpaan\b/i, 0, "none"],
  [/\bvirgin\b|mocktail|non[\s-]*alcoholic|alcohol[\s-]*free|\b0\.0\b/i, 0, "none"],

  [/monkey\s*47/i, 47, "gin"],
  [/indri/i, 46, "whisky"],
  [/royal\s*salute/i, 40, "whisky"],
  [/lagavulin/i, 43, "whisky"],
  [/hibiki|yamazaki|toki/i, 43, "whisky"],
  [/amrut|rampur/i, 42.8, "whisky"],
  [/old\s*monk|camikara/i, 42.8, "rum"],
  [/morpheus/i, 42.8, "brandy"],
  [/hendricks?/i, 41.4, "gin"],
  [/malfy/i, 41, "gin"],
  [/jaisalmer/i, 43, "gin"],
  [/talisker/i, 45.8, "whisky"],
  [/laphroaig|bowmore|glen|singleton|ardmore|jura\b/i, 40, "whisky"],
  [/xenta|absent[ah]/i, 70, "liqueur"],
  [/sambuca/i, 38, "liqueur"],
  [/ricard|anise|pastis/i, 45, "liqueur"],
  [/jager\s*bomb/i, 12, "shot"],
  [/jagerm[ei]i?ster|jager/i, 35, "liqueur"],
  [/fireball/i, 33, "liqueur"],
  [/jim\s*beam\s*(honey|orange)/i, 32.5, "whisky"],
  [/cinnamon\s*spice/i, 35, "whisky"],
  [/baileys|amarula/i, 17, "liqueur"],
  [/kahlua/i, 20, "liqueur"],
  [/campari/i, 25, "liqueur"],
  [/aperol/i, 11, "liqueur"],
  [/martini\s*(rosso|blanco|bianco|extra\s*dry)|cinzano\s*rosso|vermouth/i, 15, "liqueur"],
  // Before the beer rule: "Jameson Stout" is whiskey finished in stout casks.
  [/jameson/i, 40, "whisky"],
  [/martini\s*brut/i, 11.5, "wine"],
  [/lancer/i, 10, "wine"],
  [/lambrusco|riunite/i, 8, "wine"],
  [/long\s*island|\bliit\b/i, 22, "cocktail"],
  [/old\s*fashioned/i, 32, "cocktail"],
  [/beer\s*sampler/i, 5, "beer"],
];

/** Style defaults, checked in order after the brand list. */
const STYLES: Rule[] = [
  // Beer before wine: "Hasting Ale" has no wine word, but "rose" in a beer
  // description would otherwise pull it into wine.
  [/\bbeer\b|\bale\b|\bbira\b|lager|pilsner|weizen|stout|slout|\bipa\b|eden|tram|victorian/i, 5, "beer"],
  [/champagne|prosecco|proseco|\bbrut\b|sparkling|cuvee|moet|mumm/i, 12, "wine"],
  // Before wine: "Watermelon & Rose Tini" is a cocktail, not a rosé.
  [/martini|\btini\b|negroni|manhattan/i, 28, "cocktail"],
  [/\bwine\b|shiraz|merlot|cabernet|pinot|chardonn?ay|sangiovese|chianti|rioja|tempranil+o|pinotage|sauvignon|\brose\b/i, 12.5, "wine"],
  [/liqueur/i, 20, "liqueur"],
  // A shot before a cocktail: "a layered shot" describes itself as both.
  [/\bshot\b|kamikaze|brainstorm|b-52|smooch|hamorr?h?age/i, 25, "shot"],
  [/highball|mojito|spritz|sangria|collins|sour|fizz|cooler|sonic/i, 12, "cocktail"],
  [/cocktail|tequila meets|infused with/i, 16, "cocktail"],
  // Spirits last: "whisky" appears inside cocktail descriptions too.
  [/whisk(e)?y|scotch|bourbon|\bmalt\b|\bj\.?\s?w\b|johnnie\s*walker|chivas|ballantine|dewar|teacher|piper|jameson|jack\s*daniel|jim\s*beam|monkey\s*shoulder|black\s*&\s*white|scottish\s*leader|ranthambore|arthaus|cobalto|sangam|wood\s*burns/i, 40, "whisky"],
  [/vodka|absolut|belvedere|grey\s*goose|ciroc|skyy|stolichnaya|titos|kashmyr/i, 40, "vodka"],
  [/\bgin\b|london\s*dry|beefeat|bombay|bulldog|burnetts|greater\s*than|hapusa|\biq\b|roku|samsara|zoya/i, 40, "gin"],
  [/\brum\b|bacardi/i, 40, "rum"],
  [/tequila|reposado|blanco|patron|espolon|don\s*julio|corralejo|camino|agave/i, 40, "tequila"],
  [/cognac|brandy|hennessy|henessy|\bxo\b|\bvs\b/i, 40, "brandy"],
  // A bare colour means wine -- but only after the spirits, or "JW Red Label"
  // and "Dewars White Label" become a glass of house red.
  [/\bred\b|\bwhite\b/i, 12.5, "wine"],
];

/** A measured pour of something unnamed is almost always a spirit. */
const SPIRIT_POUR = /\(\s*30\s*ml\s*\)|\b30\s*ml\b|\(\s*btl\s*\)|^btl\b|\bbtl\b/i;

const COCKTAIL_DESC = /\bcocktail\b/i;
const COCKTAIL_RULE: Rule = [COCKTAIL_DESC, 16, "cocktail"];

type Drinkish = {name: string; desc: string | null; course: string };

/**
 * Estimated % ABV and style for one menu item, or null when it is not a drink.
 *
 * Non-alcoholic drinks are 0. An item in the bar course that matches nothing
 * reads as a 16% cocktail -- low enough that it never lands in "strong", which
 * is the promise that matters.
 */
export function classifyDrink(item: Drinkish): { abv: number; style: DrinkStyle } | null {
  if (item.course === "Beverage") return { abv: 0, style: "none" };
  if (item.course !== "Alcohol") return null;

  const hit = (rules: Rule[], text: string) => rules.find(([re]) => re.test(text));
  // Name before description, so "a gin cocktail" does not read as a bottle of gin.
  let rule = hit(BRANDS, item.name) ?? hit(STYLES, item.name);
  // A description that says "cocktail" beats a spirit in the name ("Hot
  // Buttered Rum") and the ingredients it lists: the signature "Maybe" has a
  // "sparkling finish" and "She" has rose, and neither is a glass of wine. A
  // name that already reads as a cocktail keeps its own strength.
  if (COCKTAIL_DESC.test(item.desc ?? "") && rule?.[2] !== "cocktail" && rule?.[2] !== "shot") {
    rule = COCKTAIL_RULE;
  }
  rule ??= hit(STYLES, item.desc ?? "");
  if (rule) return { abv: rule[1], style: rule[2] };
  if (SPIRIT_POUR.test(`${item.name} ${item.desc ?? ""}`)) return { abv: 40, style: "spirit" };
  return { abv: 16, style: "cocktail" };
}

export function estimateAbv(item: Drinkish): number | null {
  return classifyDrink(item)?.abv ?? null;
}

export function isAlcoholic(abv: number | null): boolean {
  return abv != null && abv >= 0.5;
}

/** The ABV range a slot accepts, or null when it says nothing about strength. */
export function abvRange(slot: {
  strength?: Strength;
  abvMin?: number;
  abvMax?: number;
}): { min: number; max: number } | null {
  const band = slot.strength && slot.strength !== "any" ? STRENGTH_BANDS[slot.strength] : null;
  if (!band && slot.abvMin == null && slot.abvMax == null) return null;
  return {
    min: slot.abvMin ?? band?.min ?? 0,
    max: slot.abvMax ?? band?.max ?? 100,
  };
}

/** Midpoint of the range, for proximity ranking. */
export function abvTarget(range: { min: number; max: number }): number {
  return range.max >= 100 ? Math.max(range.min, 40) : (range.min + range.max) / 2;
}
