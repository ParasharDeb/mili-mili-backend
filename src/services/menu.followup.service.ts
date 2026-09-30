import { prisma } from "../../db/index.ts";
import type { DietPrefEnum } from "../../generated/prisma/enums.ts";
import { recordOffer, type Session } from "../lib/session.ts";
import * as cart from "./menu.cart.service.ts";
import { toPublicItem, type PublicItem } from "./menu.items.service.ts";
import { nameKey } from "./menu.reference.ts";

/**
 * "Would you like some bread with that?" and "something to drink?" -- each
 * asked once, and only once.
 *
 * The two upsells the assistant makes. They are questions, not pitches: the
 * bread or rice fires the first time a main goes into the order without
 * anything to eat it with; the drink fires the first time food goes in while
 * the order has nothing to drink. One question per turn, each names at most two
 * things, and neither comes back. A "no" is taken at once, and so is silence --
 * a guest who moves on without answering has answered. A waiter who asks twice
 * is a waiter you avoid.
 */

export type FollowUp = {
  kind: "side" | "drink";
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

const DRINK_COURSES = new Set(["Beverage", "Alcohol", "Shisha"]);

const isDrink = (item: Pick<PublicItem, "course">) => DRINK_COURSES.has(item.course);

/** A pour or a bottle -- "Old Monk (30ml)", "Kingfisher (btl)". Not something to suggest with dinner. */
const MEASURE_RE = /\(\s*(\d+\s*ml|btl|bottle|pint)\s*\)/i;

function isAccompaniment(item: Pick<PublicItem, "course" | "name">): boolean {
  return item.course === "Bread" || (item.course === "MainCourse" && RICE_RE.test(item.name));
}

export function isDecline(message: string): boolean {
  return DECLINE_RE.test(message);
}

/**
 * The follow-up for dishes that were just added, or null.
 *
 * Bread or rice comes first, since it belongs to the dish; the drink waits for
 * the next add, or for the guest to decline the bread. Returning one spends it:
 * the session is marked so it is never asked again, and the options become the
 * last offer, so "yes, the kulcha" or "the first one" resolve against them on
 * the next turn.
 */
export async function followUpFor(session: Session, added: PublicItem[]): Promise<FollowUp | null> {
  // Adding something answers whatever was open -- tapping "+ Add" on the naan
  // card is a yes that never passes through the chat to settle it.
  if (session.followUp?.pending) session.followUp.pending = false;
  if (session.drinkFollowUp?.pending) session.drinkFollowUp.pending = false;

  const current = await cart.view(session);
  const inCart = new Set(current.lines.map((l) => l.item.id));

  // Only food that really made it into the order -- a failed add asks nothing,
  // and a drink going in is the answer to the drink question, not a reason for one.
  const food = added.filter((i) => inCart.has(i.id) && !isDrink(i));
  if (food.length === 0) return null;

  return (await sideFollowUp(session, food, current)) ?? (await drinkFollowUp(session, current));
}

async function sideFollowUp(
  session: Session,
  food: PublicItem[],
  current: cart.CartView,
): Promise<FollowUp | null> {
  if (session.followUp) return null;

  const anchor = food.find((i) => i.course === "MainCourse" && !SELF_CONTAINED_RE.test(i.name));
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
  const options = distinct(sameKitchen.length > 0 ? sameKitchen : all, 2);
  if (options.length === 0) return null;

  session.followUp = { askedAt: Date.now(), pending: true };
  offer(session, options);

  return {
    kind: "side",
    question:
      `Would you like some ${kind} with the ${anchor.name}? ` +
      `${capitalise(named(options))} ${options.length > 1 ? "would both" : "would"} go well with it.`,
    options,
    // The cards carry their own "+ Add"; the only thing left to say is no.
    chips: ["No thanks"],
  };
}

/**
 * "Something to drink with that?" -- one soft drink and one from the bar, so a
 * guest who does not drink alcohol is never offered only cocktails.
 *
 * Exported for the chat path, which asks it straight after a "no" to the bread.
 */
export async function drinkFollowUp(
  session: Session,
  current?: cart.CartView,
): Promise<FollowUp | null> {
  if (session.drinkFollowUp) return null;

  const order = current ?? (await cart.view(session));
  if (order.lines.some((l) => isDrink(l.item))) return null;

  // The dish it is offered with: the latest main, not the rice that came with it.
  const food = [...order.lines].reverse().filter((l) => !isDrink(l.item));
  const anchor = (food.find((l) => !isAccompaniment(l.item)) ?? food[0])?.item;
  if (!anchor) return null;

  // No `take`: the most popular bar rows are all pegs, and a cap cut every
  // cocktail. The bar is a few hundred rows.
  const pick = (course: "Beverage" | "Alcohol") =>
    prisma.item.findMany({
      where: { isActive: true, isAvailable: true, soldOut: false, course },
      orderBy: [{ popularity: "desc" }, { price: "asc" }],
    });
  const [soft, bar] = await Promise.all([pick("Beverage"), pick("Alcohol")]);

  // A cocktail rather than a 30ml peg or a bottle, where the bar has one.
  const barItems = bar.map(toPublicItem).filter((i) => !MEASURE_RE.test(i.name));
  const cocktails = barItems.filter((i) => i.drinkStyle === "cocktail");
  const options = distinct(
    [...distinct(soft.map(toPublicItem), 1), ...distinct(cocktails.length ? cocktails : barItems, 1)],
    2,
  );
  if (options.length === 0) return null;

  session.drinkFollowUp = { askedAt: Date.now(), pending: true };
  offer(session, options);

  return {
    kind: "drink",
    question:
      `Something to drink with the ${anchor.name}? ` +
      `${capitalise(named(options))} ${options.length > 1 ? "would both" : "would"} go well with it.`,
    options,
    chips: ["Show me more drinks", "No thanks"],
  };
}

/**
 * Settles an open follow-up on the guest's next message, whatever it says.
 *
 * Returns which question a plain "no" answered, so the caller can acknowledge
 * it and nothing more. Anything else -- a yes, a dish name, a new question --
 * returns null and is left to the normal routes.
 */
export function settleFollowUp(session: Session, message: string): FollowUp["kind"] | null {
  const open = session.followUp?.pending
    ? session.followUp
    : session.drinkFollowUp?.pending
      ? session.drinkFollowUp
      : null;
  if (!open) return null;
  open.pending = false;
  if (!isDecline(message)) return null;
  return open === session.followUp ? "side" : "drink";
}

function distinct(items: PublicItem[], max: number): PublicItem[] {
  const seen = new Set<string>();
  const out: PublicItem[] = [];
  for (const item of items) {
    const key = nameKey(item.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length === max) break;
  }
  return out;
}

function offer(session: Session, options: PublicItem[]): void {
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
}

function named(options: PublicItem[]): string {
  return options
    .map((o) => (o.price != null ? `the ${o.name} (₹${Math.round(o.price)})` : `the ${o.name}`))
    .join(" or ");
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
