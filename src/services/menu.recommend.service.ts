import { prisma } from "../../db/index.ts";
import { env, isRecoConfigured } from "../lib/env.ts";
import { AppError } from "../lib/errors.ts";
import { embed } from "../lib/mistral.ts";
import { queryItems, type ItemMatch } from "../lib/pinecone.ts";
import type { RecommendInput, Slot, SlotPlan } from "../schemas/menu.schema.ts";
import {
  allowedCourses,
  buildFilter,
  dietAllows,
  relaxSlot,
  RELAXATIONS,
  type Relaxation,
} from "./menu.filter.ts";
import { parseQuery } from "./menu.parse.service.ts";

const SPICE_WORDS = ["not spicy", "very mild", "mild", "medium spicy", "hot", "very spicy"];

const DIET_WORDS: Record<string, string> = {
  Vegeterian: "Vegetarian",
  Non_vegeterian: "Non-vegetarian",
  Eggeterian: "Eggetarian",
  OnlyFish: "Pescatarian",
  Jain: "Jain",
};

type Row = Awaited<ReturnType<typeof prisma.item.findMany>>[number];

/** A short deterministic explanation. An LLM call here would cost latency and invite hallucination. */
function explain(row: Row): string {
  const bits = [DIET_WORDS[row.diet] ?? row.diet];
  if (row.spiceConfidence != null && row.spiceConfidence >= 0.5) {
    bits.push(SPICE_WORDS[row.spice] ?? "medium spicy");
  }
  bits.push(row.cuisine, row.course);
  return bits.join(" · ");
}

/** Two dishes under different ids but the same name look like a broken result. */
function nameKey(name: string): string {
  return name.toLowerCase().replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim();
}

function countClauses(slot: Slot): number {
  return [slot.diet, slot.spice, slot.cuisine, slot.course].filter((v) => v !== "any").length;
}

type Assignment = { slotIndex: number; matches: ItemMatch[]; relaxations: Relaxation[] };

export type ParsedQuery = { plan: SlotPlan; mode: "llm" | "heuristic" };

/**
 * `pre` lets a caller that has already parsed the sentence (the chat dispatcher,
 * which parses to decide whether this is even a recommendation) pass the result
 * in rather than paying for a second LLM round-trip.
 */
export async function recommend(input: RecommendInput, pre?: ParsedQuery) {
  if (!isRecoConfigured) {
    throw new AppError(
      503,
      "Recommendations are not configured. Set MISTRAL_API_KEY and PINECONE_API_KEY.",
      "RECO_UNCONFIGURED",
    );
  }

  const started = Date.now();
  const { plan, mode } = pre ?? (await parseQuery(input.query));
  const warnings: { code: string; slotId?: string; message: string }[] = [];

  if (plan.slots.length === 0) {
    return {
      query: input.query,
      partySize: plan.partySize,
      perSlot: input.perSlot,
      groups: [],
      warnings: [{
        code: "NO_CONSTRAINTS_FOUND",
        message: "No dietary or cuisine constraints were found in that request.",
      }],
      meta: { parseMode: mode, tookMs: Date.now() - started },
    };
  }

  const slots = plan.slots.slice(0, env.RECO_MAX_SLOTS);
  if (plan.slots.length > slots.length) {
    warnings.push({
      code: "SLOTS_TRUNCATED",
      message: `Only the first ${slots.length} constraints were used.`,
    });
  }

  // One embeddings call for every slot -- the API takes an array.
  const vectors = await embed(slots.map((s) => s.searchText));

  const candidateSets = await Promise.all(
    slots.map((slot, i) =>
      queryItems(vectors[i]!, buildFilter(slot, input.includeDrinks), env.RECO_CANDIDATE_TOPK),
    ),
  );

  // Fetch in parallel, assign sequentially. Scarcity first, so a thin constraint
  // ("non veg spicy") is not starved by a greedy earlier slot taking its dishes.
  // When Pinecone returns fewer than topK, that IS the complete eligible set,
  // which makes this an exact scarcity measure rather than a guess.
  const order = slots
    .map((_, i) => i)
    .sort((a, b) =>
      candidateSets[a]!.length - candidateSets[b]!.length ||
      countClauses(slots[b]!) - countClauses(slots[a]!) ||
      a - b,
    );

  const usedIds = new Set<string>();
  const usedNames = new Set<string>();
  const assignments = new Map<number, Assignment>();

  const take = (pool: ItemMatch[], into: ItemMatch[], want: number) => {
    for (const m of pool) {
      if (into.length >= want) break;
      const nk = nameKey(m.name);
      if (usedIds.has(m.id) || usedNames.has(nk)) continue;
      into.push(m);
      usedIds.add(m.id);
      usedNames.add(nk);
    }
  };

  for (const i of order) {
    const slot = slots[i]!;
    const picked: ItemMatch[] = [];
    const relaxations: Relaxation[] = [];

    take(candidateSets[i]!, picked, input.perSlot);

    // Climb the relaxation ladder only as far as needed. Diet is never on it.
    for (const rung of RELAXATIONS) {
      if (picked.length >= input.perSlot) break;
      const relaxed = relaxSlot(slot, rung);
      if (!relaxed) continue;

      const more = await queryItems(
        vectors[i]!,
        buildFilter(relaxed, input.includeDrinks),
        env.RECO_CANDIDATE_TOPK,
      );
      const before = picked.length;
      take(more, picked, input.perSlot);
      if (picked.length > before) relaxations.push(rung);
    }

    assignments.set(i, { slotIndex: i, matches: picked, relaxations });
  }

  // Hydrate every candidate at once; Postgres is the truth, Pinecone is a cache.
  const ids = [...new Set([...assignments.values()].flatMap((a) => a.matches.map((m) => m.id)))];
  const rows = await prisma.item.findMany({ where: { id: { in: ids } } });
  const byId = new Map(rows.map((r) => [r.id, r]));

  const groups = slots.map((slot, i) => {
    const assignment = assignments.get(i)!;
    const recommendations = [];

    for (const match of assignment.matches) {
      const row = byId.get(match.id);
      if (!row) {
        // Vector outlived its row. Real case: nothing re-embeds on item delete.
        console.warn(`[recommend] vector ${match.id} has no Postgres row; dropping`);
        continue;
      }
      // Re-check the promise we actually made, against live data.
      if (!dietAllows(slot.diet, row.diet)) {
        console.warn(
          `[recommend] stale Pinecone metadata: ${row.name} (${row.id}) is ${row.diet} ` +
            `but matched a '${slot.diet}' slot. Re-run python ingest.py.`,
        );
        continue;
      }
      const courses = allowedCourses(slot, input.includeDrinks);
      if (courses && !courses.includes(row.course)) continue;

      recommendations.push({
        rank: recommendations.length + 1,
        score: Number(match.score.toFixed(4)),
        why: explain(row),
        item: {
          id: row.id,
          name: row.name,
          desc: row.desc,
          cuisine: row.cuisine,
          course: row.course,
          diet: row.diet,
          protein: row.protein,
          spice: row.spice,
          spiceConfidence: row.spiceConfidence,
          tasteTags: row.tasteTags,
          serves: row.serves,
          allergens: row.allergens,
        },
      });
    }

    const slotId = `slot_${i + 1}`;
    const shortfall = Math.max(0, input.perSlot - recommendations.length);

    if (assignment.relaxations.length > 0) {
      warnings.push({
        code: "SLOT_RELAXED",
        slotId,
        message: `Relaxed ${assignment.relaxations.join(", ")} to find enough matches for "${slot.label}".`,
      });
    }
    if (recommendations.length === 0) {
      // The diet clause is the only one never relaxed, so when a slot comes back
      // completely empty it is almost always because the menu has no such dish.
      const binding = slot.diet !== "any" ? `no ${slot.diet} dishes` : "no dishes";
      warnings.push({
        code: "SLOT_NO_MATCHES",
        slotId,
        message:
          `Found ${binding} matching "${slot.label}" on this menu. ` +
          `Dietary constraints are never relaxed, so nothing was substituted.`,
      });
    } else if (shortfall > 0) {
      warnings.push({
        code: "SLOT_SHORTFALL",
        slotId,
        message: `Only ${recommendations.length} of ${input.perSlot} options available for "${slot.label}".`,
      });
    }

    return {
      id: slotId,
      label: slot.label,
      // `count` is guests covered; `recommendations` is options offered. Different numbers.
      count: slot.count,
      constraints: {
        diet: slot.diet,
        spice: slot.spice,
        cuisine: slot.cuisine,
        course: slot.course,
        courseGroup: slot.courseGroup,
      },
      searchText: slot.searchText,
      relaxations: assignment.relaxations,
      shortfall,
      recommendations,
    };
  });

  const assignedGuests = groups.reduce((n, g) => n + g.count, 0);

  return {
    query: input.query,
    partySize: plan.partySize,
    assignedGuests,
    // Stated counts may not add up. Report it rather than inventing a filler slot.
    unassignedGuests: Math.max(0, plan.partySize - assignedGuests),
    perSlot: input.perSlot,
    groups,
    warnings,
    meta: {
      parseMode: mode,
      chatModel: env.MISTRAL_CHAT_MODEL,
      embedModel: env.MISTRAL_EMBED_MODEL,
      tookMs: Date.now() - started,
    },
  };
}
