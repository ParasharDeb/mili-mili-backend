import type { Slot } from "../schemas/menu.schema.ts";
import { SPICE_MIN_CONFIDENCE } from "../domain/menu.constants.ts";
import { SPICE_TARGET } from "./menu.filter.ts";
import { abvRange, abvTarget } from "../domain/abv.ts";

/**
 * Deterministic relevance scoring. Pure -- no I/O, no database -- so the weights
 * can be tested and argued about without a live Postgres.
 *
 * This replaces cosine similarity over an embedding. SQL does the filtering and
 * computes the three lexical signals (Postgres already ships trigram similarity
 * and ts_rank_cd; reimplementing them in JavaScript would only invite drift from
 * the index). Everything else is combined here.
 *
 * The property the vector path never had: the same question scores the same way
 * twice, and every term can be explained to a guest.
 */

/** Lexical signals computed by Postgres in menu.sql.service.ts. */
export type RankSignals = {
  /** similarity(name, searchText), 0..1 */
  nameSim: number;
  /** similarity(desc, searchText), 0..1 */
  descSim: number;
  /** ts_rank_cd over the weighted search_vector. Small in practice: 0.05..0.3 */
  tsRank: number;
};

export type RankableItem = {
  name: string;
  desc: string | null;
  cuisine: string;
  protein: string;
  spice: number;
  spiceConfidence: number | null;
  tasteTags: string[];
  tags: string[];
  popularity: number;
  /** Estimated % ABV; null for food. */
  abv?: number | null;
};

const WEIGHTS = {
  lexical: 0.35,
  tagOverlap: 0.15,
  spiceFit: 0.18,
  cuisineFit: 0.12,
  proteinFit: 0.08,
  popularity: 0.08,
  completeness: 0.04,
} as const;

const STOPWORDS = new Set([
  "a", "an", "and", "the", "to", "for", "of", "or", "with", "some", "any",
  "something", "anything", "dish", "dishes", "food", "item", "items", "please",
  "good", "nice", "popular", "share", "sharing", "eat", "order", "want", "like",
  "me", "us", "we", "i", "my", "our", "is", "are", "be", "it", "that", "this",
  "one", "ones", "thing", "things", "option", "options", "on", "in", "at",
]);

const PROTEIN_WORDS: Record<string, string> = {
  chicken: "Chicken", murgh: "Chicken",
  mutton: "Mutton", lamb: "Mutton", goat: "Mutton",
  fish: "Fish", prawn: "Prawns", prawns: "Prawns", shrimp: "Prawns",
  egg: "Egg", eggs: "Egg",
  paneer: "Paneer", tofu: "Tofu",
};

/**
 * Lowercased content words, stopwords removed, crudely singularised.
 *
 * The emptiness of this list is load-bearing -- see `scoreItem`.
 */
export function contentWords(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    const word = raw.length > 4 && raw.endsWith("s") ? raw.slice(0, -1) : raw;
    if (!out.includes(word)) out.push(word);
  }
  return out;
}

function lexical(signals: RankSignals): number {
  // A word in a long description is weaker evidence than the same word in a
  // name, hence the discount. ts_rank_cd lands around 0.05-0.3, hence the x4.
  return Math.min(
    1,
    Math.max(signals.nameSim, 0.85 * signals.descSim, Math.min(1, signals.tsRank * 4)),
  );
}

function tagOverlap(item: RankableItem, words: string[]): number {
  if (words.length === 0) return 0;
  const bag = new Set([...item.tasteTags, ...item.tags].map((t) => t.toLowerCase()));
  const hits = words.filter((w) => bag.has(w)).length;
  return hits / words.length;
}

/**
 * 0.5 is deliberately neutral, and applies in two cases: the guest stated no
 * heat preference, and nobody has assessed this dish's heat. A dish the kitchen
 * never rated must not be punished for a number nobody stood behind.
 */
function spiceFit(item: RankableItem, slot: Slot): number {
  const target = SPICE_TARGET[slot.spice];
  if (target == null) return 0.5;
  if (item.spiceConfidence == null || item.spiceConfidence < SPICE_MIN_CONFIDENCE) return 0.5;
  return Math.max(0, 1 - Math.abs(item.spice - target) / 5);
}

/**
 * Closeness to the asked-for strength. "Strong" targets 40% rather than the top
 * of the band, so a Glenfiddich outranks a 70% absinthe nobody asked for.
 */
function abvFit(item: RankableItem, slot: Slot): number | null {
  const range = abvRange(slot);
  if (!range || item.abv == null) return null;
  return Math.max(0, 1 - Math.abs(item.abv - abvTarget(range)) / 40);
}

function cuisineFit(item: RankableItem, slot: Slot): number {
  if (slot.cuisine !== "any") return item.cuisine === slot.cuisine ? 1 : 0;
  // The cuisine_softened rung dropped the hard filter but kept the preference.
  if (slot.softenedCuisine) return item.cuisine === slot.softenedCuisine ? 0.25 : 0;
  return 0.5;
}

function proteinFit(item: RankableItem, words: string[]): number {
  const wanted = words.map((w) => PROTEIN_WORDS[w]).filter(Boolean);
  if (wanted.length === 0) return 0.5;
  return wanted.includes(item.protein) ? 1 : 0;
}

export function scoreItem(item: RankableItem, slot: Slot, signals: RankSignals): number {
  const words = contentWords(slot.searchText);

  const w = { ...WEIGHTS } as Record<keyof typeof WEIGHTS, number>;

  // "What should we order for four?" produces searchText like "popular dish to
  // share", which is entirely stopwords. Trigram similarity against that is
  // noise, and would rank dishes by accidental letter overlap. Move its weight
  // onto popularity instead: asked what is good, answer with what people order.
  if (words.length === 0) {
    w.popularity += w.lexical + w.tagOverlap;
    w.lexical = 0;
    w.tagOverlap = 0;
  }

  // Heat means nothing at the bar, so a strength request takes over its weight.
  const strength = abvFit(item, slot);

  return (
    w.lexical * lexical(signals) +
    w.tagOverlap * tagOverlap(item, words) +
    w.spiceFit * (strength ?? spiceFit(item, slot)) +
    w.cuisineFit * cuisineFit(item, slot) +
    w.proteinFit * proteinFit(item, words) +
    w.popularity * (Math.min(item.popularity, 3) / 3) +
    w.completeness * (item.desc?.trim() ? 1 : 0)
  );
}

/**
 * Sorts in place, most relevant first.
 *
 * The tiebreak chain is total, so two identical questions return the same order.
 * `popularity` is capped at 3 in the score and used only here beyond that: the
 * POS "Bestseller" flag is somebody ticking a box, not sales data.
 */
export function rankBy<T extends { score: number; popularity: number; price: number; name: string }>(
  rows: T[],
): T[] {
  return rows.sort(
    (a, b) =>
      b.score - a.score ||
      b.popularity - a.popularity ||
      a.price - b.price ||
      a.name.localeCompare(b.name),
  );
}
