import { prisma } from "../../db/index.ts";
import type { DietPrefEnum } from "../../generated/prisma/enums.ts";
import { recordOffer, type Session } from "../lib/session.ts";
import * as cart from "./menu.cart.service.ts";
import { toPublicItem, type PublicItem } from "./menu.items.service.ts";
import { nameKey } from "./menu.reference.ts";

/**
 * "Would you like some bread with that?" -- asked once, and only once.
 *
 * The one upsell the assistant makes. It is a question, not a pitch: it fires
 * the first time a main goes into the order without anything to eat it with,
 * names at most two things that actually go with it, and never comes back. A
 * "no" is taken at once, and so is silence -- a guest who moves on without
 * answering has answered. A waiter who asks twice is a waiter you avoid.
 */

export type FollowUp = {
  question: string;
  options: PublicItem[];
  chips: string[];
};

/** A main that already carries its own carb, or is one. Nothing to offer beside it. */
const SELF_CONTAINED_RE =
  /\b(rice|noodles?|biryani|pulao|pizza|burger|sandwich|wrap|bao|kulcha|naan|roti|paratha|flat ?bread|risotto|khichdi)\b/i;

const RICE_RE = /\b(rice|pulao)\b/i;

const DECLINE_RE =
  /^\s*(no|nope|nah|no thanks?|no,? thank you|not now|not today|i'?m good|i'?m fine|we'?re good|all good|that'?s (all|it|fine)|skip( it)?|pass|none)\s*[.!]*\s*$/i;

/** What goes beside a main, by the kitchen it came from. */
const PAIRS_WITH: Record<string, "bread" | "rice"> = {
  Indian: "bread",
  Asian: "rice",
  Italian: "bread",
  Continental: "bread",
};

/**
 * A vegetarian is never offered meat to go with their dal, however good the
 * kulcha. The accompaniment must fit the diet of the dish it is for.
 */
const COMPATIBLE_DIETS: Record<string, DietPrefEnum[]> = {
  Jain: ["Jain"],
  Vegetarian: ["Vegetarian", "Jain"],
  Eggetarian: ["Vegetarian", "Jain", "Eggetarian"],
  OnlyFish: ["Vegetarian", "Jain", "Eggetarian", "OnlyFish"],
  NonVegetarian: ["Vegetarian", "Jain", "Eggetarian", "OnlyFish", "NonVegetarian"],
};

function isAccompaniment(item: Pick<PublicItem, "course" | "name">): boolean {
  return item.course === "Bread" || (item.course === "MainCourse" && RICE_RE.test(item.name));
}

export function isDecline(message: string): boolean {
  return DECLINE_RE.test(message);
}

/**
 * The follow-up for dishes that were just added, or null.
 *
 * Returning one spends it: the session is marked so it is never asked again,
 * and the options become the last offer, so "yes, the kulcha" or "the first
 * one" resolve against them on the next turn.
 */
export async function followUpFor(session: Session, added: PublicItem[]): Promise<FollowUp | null> {
  if (session.followUp) return null;

  const current = await cart.view(session);
  const inCart = new Set(current.lines.map((l) => l.item.id));

  // Only a main that really made it into the order -- a failed add asks nothing.
  const anchor = added.find(
    (i) => inCart.has(i.id) && i.course === "MainCourse" && !SELF_CONTAINED_RE.test(i.name),
  );
  if (!anchor) return null;

  // Something to eat it with is already on the way.
  if (current.lines.some((l) => isAccompaniment(l.item))) return null;

  const kind = PAIRS_WITH[anchor.cuisine] ?? "bread";
  const diets = COMPATIBLE_DIETS[anchor.diet] ?? (["Vegetarian", "Jain"] as DietPrefEnum[]);

  const rows = await prisma.item.findMany({
    where: {
      isActive: true,
      isAvailable: true,
      soldOut: false,
      diet: { in: diets },
      ...(kind === "rice"
        ? { course: "MainCourse", name: { contains: "rice", mode: "insensitive" } }
        : { course: "Bread" }),
    },
    orderBy: [{ popularity: "desc" }, { price: "asc" }],
  });

  // Same kitchen only -- a kulcha beside a dal, never sourdough garlic bread.
  // Another kitchen's bread is offered only when this one has none at all.
  const all = rows.map(toPublicItem);
  const sameKitchen = all.filter((i) => i.cuisine === anchor.cuisine);
  const candidates = sameKitchen.length > 0 ? sameKitchen : all;

  const seen = new Set<string>();
  const options: PublicItem[] = [];
  for (const item of candidates) {
    const key = nameKey(item.name);
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(item);
    if (options.length === 2) break;
  }
  if (options.length === 0) return null;

  session.followUp = { askedAt: Date.now(), pending: true };
  recordOffer(
    session,
    "follow_up",
    options.map((item) => ({
      id: item.id,
      name: item.name,
      nameKey: nameKey(item.name),
      diet: item.diet,
      protein: item.protein,
      spice: item.spice,
      spiceConfidence: item.spiceConfidence,
      price: item.price,
    })),
  );

  const named = options.map((o) => (o.price != null ? `the ${o.name} (₹${Math.round(o.price)})` : `the ${o.name}`));
  return {
    question:
      `Would you like some ${kind} with the ${anchor.name}? ` +
      `${capitalise(named.join(" or "))} ${options.length > 1 ? "would both" : "would"} go well with it.`,
    options,
    chips: [...options.map((o) => `Add the ${o.name}`), "No thanks"],
  };
}

/**
 * Settles an open follow-up on the guest's next message, whatever it says.
 *
 * Returns true when that message was a plain "no", so the caller can answer it
 * with an acknowledgement and nothing more. Anything else -- a yes, a dish
 * name, a new question -- is left to the normal routes.
 */
export function settleFollowUp(session: Session, message: string): boolean {
  if (!session.followUp?.pending) return false;
  session.followUp.pending = false;
  return isDecline(message);
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
