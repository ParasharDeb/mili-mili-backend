import { prisma } from "../../db/index.ts";
import { env, isRecoConfigured } from "../lib/env.ts";
import { AppError, notFound } from "../lib/errors.ts";
import { embed } from "../lib/mistral.ts";
import { queryItems } from "../lib/pinecone.ts";
import { FOOD_COURSES, toPublicItem, type PublicItem } from "./menu.items.service.ts";

/**
 * Food <-> drink pairing for a single item ("I ordered the butter chicken, what
 * should I drink"; "I'm having the Old Fashioned, what should I eat").
 *
 * Semantic similarity alone is a weak pairing signal: a dish and a spirit live in
 * different halves of the menu and rarely share vocabulary, and the LLM
 * enrichment leaves plain spirits ("Skyy (30ml)") almost tag-less because there
 * is little to say about a base vodka on its own (see rag/enrich.py). So this
 * blends two signals: the embedding (which does carry some of the model's world
 * knowledge -- "Laphroaig" reads as smoky even with a bare product name) and a
 * small deterministic flavour-affinity table over the fields the enrichment does
 * produce reliably (spice, tasteTags, protein, course). Same "no LLM for the
 * explanation" rule as menu.recommend.service.ts: an extra chat call here would
 * add latency and a chance to hallucinate a pairing that makes no sense.
 */

const PAIR_DRINK_COURSES = ["Alcohol", "Beverage"];

type ItemRow = NonNullable<Awaited<ReturnType<typeof prisma.item.findUnique>>>;

/** Pairs well with -> the tags on the other side worth boosting for. */
const AFFINITY: Record<string, string[]> = {
  spicy: ["sweet", "refreshing", "fruity", "creamy", "citrusy", "crisp"],
  smoky: ["smoky", "rich", "bold"],
  tandoori: ["smoky", "rich"],
  charred: ["smoky", "rich"],
  grilled: ["smoky", "rich"],
  creamy: ["tangy", "citrusy", "sparkling", "crisp", "bitter"],
  cheesy: ["tangy", "citrusy", "sparkling"],
  rich: ["tangy", "citrusy", "sparkling", "crisp", "bold"],
  savoury: ["crisp", "bold", "smoky"],
  tangy: ["sweet", "rich", "creamy"],
  sweet: ["bitter", "tangy", "rich"],
  citrusy: ["crisp", "light", "fresh", "creamy", "rich"],
  crispy: ["crisp", "refreshing", "light"],
  light: ["crisp", "citrusy", "fresh"],
  fresh: ["light", "crisp"],
  refreshing: ["light", "crisp", "spicy"],
  seafood: ["crisp", "citrusy", "light", "fresh", "sparkling"],
  dessert: ["sweet", "creamy", "bitter"],
};

/**
 * Two phrase sets, not one: "both spicy" and "spicy wants something cooling" are
 * opposite claims, so reusing one phrase table for both a literal tag match and
 * an affinity match says the wrong thing half the time (a spicy drink paired
 * with a spicy dish must not read "something cooling for the heat").
 */
const SHARED_PHRASES: Record<string, string> = {
  spicy: "Both bring the heat",
  smoky: "Echoes the char",
  tandoori: "Echoes the tandoor char",
  charred: "Echoes the char",
  grilled: "Echoes the char",
  creamy: "Matches the creamy texture",
  cheesy: "Matches the richness",
  rich: "Matches the richness",
  savoury: "Matches the savoury depth",
  tangy: "Shares the tang",
  sweet: "Matches the sweetness",
  citrusy: "Matches the citrus notes",
  crispy: "Matches the crunch",
  light: "Just as light",
  fresh: "Just as fresh",
  refreshing: "Just as refreshing",
  seafood: "Both lean seafood-light",
  dessert: "Both dessert-leaning",
};

/** Phrase for when the source's tag is satisfied by a *complementary* tag on the
 * candidate (the AFFINITY table below), not a literal match. */
const WANT_PHRASES: Record<string, string> = {
  spicy: "Something cooling for the heat",
  smoky: "Complements the char",
  tandoori: "Complements the tandoor char",
  charred: "Complements the char",
  grilled: "Complements the char",
  creamy: "Cuts through the richness",
  cheesy: "Cuts through the richness",
  rich: "Cuts through the richness",
  savoury: "Rounds out the savoury depth",
  tangy: "Balances the tang",
  sweet: "Balances the sweetness",
  citrusy: "Balances the citrus",
  crispy: "A crisp contrast",
  light: "Keeps it light",
  fresh: "Keeps it fresh",
  refreshing: "Stays refreshing",
  seafood: "Light enough for seafood",
  dessert: "Made for dessert",
};

/**
 * Tags derived from structured fields, so pairing still works when `tasteTags`
 * is sparse (true for most plain spirits -- there just isn't much to say about a
 * bottle of Skyy beyond its name).
 */
function flavorTags(row: ItemRow): Set<string> {
  const tags = new Set(row.tasteTags.map((t) => t.toLowerCase()));
  if (row.spiceConfidence != null && row.spiceConfidence >= 0.5 && row.spice >= 3) tags.add("spicy");
  if (row.protein === "Fish" || row.protein === "Prawns") tags.add("seafood");
  if (row.course === "Dessert") tags.add("dessert");
  return tags;
}

function affinityScore(sourceTags: Set<string>, candidateTags: Set<string>): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  for (const tag of sourceTags) {
    if (candidateTags.has(tag)) {
      score += 0.2;
      reasons.push(SHARED_PHRASES[tag] ?? `Shares the ${tag} note`);
      continue;
    }
    for (const want of AFFINITY[tag] ?? []) {
      if (candidateTags.has(want)) {
        score += 0.15;
        reasons.push(WANT_PHRASES[tag] ?? `Pairs with ${tag}`);
        break;
      }
    }
  }

  return { score: Math.min(1, score), reasons: [...new Set(reasons)] };
}

/** The sentence embedded for retrieval -- mirrors rag/menu_rag/documents.py closely
 * enough to land in the same part of embedding space as the indexed items. */
function pairingText(row: ItemRow): string {
  const bits = [row.name];
  if (row.desc?.trim()) bits.push(row.desc.trim());
  bits.push(`A ${row.course} from the ${row.cuisine} menu.`);
  if (row.protein !== "None") bits.push(`Main protein: ${row.protein.toLowerCase()}.`);
  if (row.spiceConfidence != null && row.spiceConfidence >= 0.5) {
    bits.push(`Spice level ${row.spice} out of 5.`);
  }
  if (row.tasteTags.length) bits.push(`Tastes ${row.tasteTags.join(", ")}.`);
  return bits.join(" ");
}

/** Same "same dish, two rows" problem as menu.recommend.service.ts -- "Glenfiddich
 * 12yrs (30ml)" and "Glenfiddich 12yrs (btl)" are the same pairing, said twice. */
function nameKey(name: string): string {
  return name.toLowerCase().replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim();
}

function explainPairing(reasons: string[], row: ItemRow): string {
  if (reasons.length > 0) return reasons.slice(0, 2).join(" · ");
  const isFood = (FOOD_COURSES as readonly string[]).includes(row.course);
  return isFood ? "A well-matched dish from the kitchen" : "A well-matched pick from the bar";
}

export type PairingResult = {
  item: PublicItem;
  direction: "food_to_drink" | "drink_to_food";
  pairings: { rank: number; score: number; why: string; item: PublicItem }[];
  meta: { tookMs: number; embedModel: string };
};

export async function pairings(itemId: string, limit: number): Promise<PairingResult> {
  if (!isRecoConfigured) {
    throw new AppError(
      503,
      "Recommendations are not configured. Set MISTRAL_API_KEY and PINECONE_API_KEY.",
      "RECO_UNCONFIGURED",
    );
  }

  const started = Date.now();
  const item = await prisma.item.findUnique({ where: { id: itemId } });
  if (!item) throw notFound("Item not found", "ITEM_NOT_FOUND");

  const isFood = (FOOD_COURSES as readonly string[]).includes(item.course);
  const isDrink = PAIR_DRINK_COURSES.includes(item.course);
  if (!isFood && !isDrink) {
    throw new AppError(
      422,
      `Pairing suggestions aren't supported for ${item.course} items yet.`,
      "PAIRING_NOT_SUPPORTED",
    );
  }

  const direction: PairingResult["direction"] = isFood ? "food_to_drink" : "drink_to_food";
  const targetCourses = isFood ? PAIR_DRINK_COURSES : [...FOOD_COURSES];

  const [vector] = await embed([pairingText(item)]);
  const matches = await queryItems(vector!, { course: { $in: targetCourses } }, Math.max(20, limit * 6));

  const rows = await prisma.item.findMany({ where: { id: { in: matches.map((m) => m.id) } } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const sourceTags = flavorTags(item);

  const scored = matches
    .map((m) => {
      const row = byId.get(m.id);
      if (!row) return null;
      const { score: affinity, reasons } = affinityScore(sourceTags, flavorTags(row));
      // Semantic similarity carries most of the weight; the affinity table is a
      // rerank on top of it, not a replacement -- it only ever nudges within the
      // set Pinecone already thought was relevant.
      return { row, finalScore: 0.55 * m.score + 0.45 * affinity, reasons };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.finalScore - a.finalScore);

  const usedNames = new Set<string>();
  const picked: typeof scored = [];
  for (const s of scored) {
    const nk = nameKey(s.row.name);
    if (usedNames.has(nk)) continue;
    usedNames.add(nk);
    picked.push(s);
    if (picked.length >= limit) break;
  }

  return {
    item: toPublicItem(item),
    direction,
    pairings: picked.map((p, i) => ({
      rank: i + 1,
      score: Number(p.finalScore.toFixed(4)),
      why: explainPairing(p.reasons, p.row),
      item: toPublicItem(p.row),
    })),
    meta: { tookMs: Date.now() - started, embedModel: env.MISTRAL_EMBED_MODEL },
  };
}
