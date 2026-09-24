import { env } from "../lib/env.ts";
import type { RecommendInput, Slot, SlotPlan } from "../schemas/menu.schema.ts";
import { DIET_WORDS, SPICE_MIN_CONFIDENCE, SPICE_WORDS } from "../domain/menu.constants.ts";
import {
  abvAllows,
  allowedCourses,
  dietAllows,
  relaxSlot,
  RELAXATIONS,
  type Relaxation,
} from "./menu.filter.ts";
import { findCandidates, type CandidateRow } from "./menu.sql.service.ts";

/**
 * Multi-slot constrained retrieval.
 *
 * The structure here -- scarcity-first assignment, global dedupe, a relaxation
 * ladder that never touches diet -- is unchanged from when candidates came from
 * a vector index. Only the source changed: `findCandidates` runs SQL against
 * Postgres and returns fully hydrated, already-scored rows, so there is no
 * separate hydrate step and no stale-metadata class of bug to guard against.
 */

/** A short deterministic explanation. An LLM here would cost latency and invite hallucination. */
function explain(row: CandidateRow): string {
  const bits = [DIET_WORDS[row.diet] ?? row.diet];
  if (row.spiceConfidence != null && row.spiceConfidence >= SPICE_MIN_CONFIDENCE) {
    bits.push(SPICE_WORDS[row.spice] ?? "medium spicy");
  }
  if (row.course === "Alcohol" || row.course === "Beverage") {
    // Drinks: the cuisine column just says "Beverage", and strength is the fact
    // a guest choosing between them actually wants.
    bits.length = 0;
    bits.push(row.course === "Alcohol" ? "Alcoholic" : "Non-alcoholic");
    if (row.course === "Alcohol" && row.abv != null) bits.push(`~${row.abv}% ABV`);
  } else {
    bits.push(row.cuisine, row.course);
  }
  if (row.price != null) bits.push(`₹${Math.round(row.price)}`);
  return bits.join(" · ");
}

/** Two dishes under different ids but the same name look like a broken result. */
function nameKey(name: string): string {
  return name.toLowerCase().replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim();
}

function countClauses(slot: Slot): number {
  return [slot.diet, slot.spice, slot.cuisine, slot.course].filter((v) => v !== "any").length;
}

type Assignment = { slotIndex: number; matches: CandidateRow[]; relaxations: Relaxation[] };

export type ParsedQuery = { plan: SlotPlan; mode: "jev" | "heuristic" };

export async function recommend(input: RecommendInput, pre: ParsedQuery) {
  const started = Date.now();
  const { plan, mode } = pre;
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
      meta: { slotMode: mode, tookMs: Date.now() - started },
    };
  }

  const slots = plan.slots.slice(0, env.RECO_MAX_SLOTS);
  if (plan.slots.length > slots.length) {
    warnings.push({
      code: "SLOTS_TRUNCATED",
      message: `Only the first ${slots.length} constraints were used.`,
    });
  }

  const candidateSets = await Promise.all(
    slots.map((slot) =>
      findCandidates(slot, {
        includeDrinks: input.includeDrinks,
        limit: env.RECO_CANDIDATE_TOPK,
      }),
    ),
  );

  // Fetch in parallel, assign sequentially. Scarcity first, so a thin constraint
  // ("non veg spicy") is not starved by a greedy earlier slot taking its dishes.
  // With SQL and a limit above the table size, the candidate count IS the
  // complete eligible set -- an exact scarcity measure, not an estimate.
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

  const take = (pool: CandidateRow[], into: CandidateRow[], want: number) => {
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
    const picked: CandidateRow[] = [];
    const relaxations: Relaxation[] = [];

    take(candidateSets[i]!, picked, input.perSlot);

    // Climb the relaxation ladder only as far as needed. Diet is never on it.
    for (const rung of RELAXATIONS) {
      if (picked.length >= input.perSlot) break;
      const relaxed = relaxSlot(slot, rung);
      if (!relaxed) continue;

      const more = await findCandidates(relaxed, {
        includeDrinks: input.includeDrinks,
        limit: env.RECO_CANDIDATE_TOPK,
      });
      const before = picked.length;
      take(more, picked, input.perSlot);
      if (picked.length > before) relaxations.push(rung);
    }

    assignments.set(i, { slotIndex: i, matches: picked, relaxations });
  }

  const groups = slots.map((slot, i) => {
    const assignment = assignments.get(i)!;
    const recommendations = [];

    for (const row of assignment.matches) {
      // Re-check the promise we actually made. The query built this set, so this
      // should be tautological -- which is the point: it is the last line of
      // defence against a bug in the filter, and it costs nothing.
      if (!dietAllows(slot.diet, row.diet)) {
        console.warn(
          `[recommend] ${row.name} (${row.id}) is ${row.diet} but matched a ` +
            `'${slot.diet}' slot. This is a bug in menu.filter.ts or menu.sql.service.ts.`,
        );
        continue;
      }
      const courses = allowedCourses(slot, input.includeDrinks);
      if (courses && !courses.includes(row.course)) continue;
      // Alcoholic vs non-alcoholic is always re-checked; the % bounds and the
      // style only if they were not deliberately relaxed away.
      const relaxed = assignment.relaxations;
      const checked = {
        ...slot,
        ...(relaxed.includes("strength_dropped")
          ? { strength: "any" as const, abvMin: undefined, abvMax: undefined }
          : relaxed.includes("strength_widened") ? relaxSlot(slot, "strength_widened") ?? {} : {}),
        ...(relaxed.includes("style_dropped") ? { drinkStyle: undefined } : {}),
      };
      if (!abvAllows(checked, row.abv, row.drinkStyle)) continue;

      const { score, signals, popularity, ...item } = row;
      recommendations.push({
        rank: recommendations.length + 1,
        score: Number(score.toFixed(4)),
        why: explain(row),
        item,
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
      slotMode: mode,
      chatModel: env.MISTRAL_CHAT_MODEL,
      tookMs: Date.now() - started,
    },
  };
}
