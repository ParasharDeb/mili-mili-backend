import { env } from "../lib/env.ts";
import { askJev, choice, decided, isTrue, noul, score } from "../lib/jev.ts";
import type { Session } from "../lib/session.ts";
import { CHUNK_QUESTIONS, heuristicPlan } from "./menu.slots.service.ts";

/**
 * Decides what a chat turn is asking for, before anything else runs.
 *
 * One Jev request carries every question about the turn, including the
 * per-chunk slot questions -- they are evaluated in parallel and the state is
 * billed once, so a single-constraint request costs exactly one round trip end
 * to end. Only a genuinely multi-part request fans out (see planSlots).
 */

export type Intent =
  | "structured_query"
  | "advisory"
  | "dish_question"
  | "cart_action"
  | "smalltalk";

export type CartOp = "add" | "remove" | "set_quantity" | "view" | "clear";

export type ReferentKind =
  | "ordinal" | "by_name" | "by_attribute" | "all_offered" | "bare_yes" | "unclear";

export type Route = {
  intent: Intent;
  confidence: number;
  confirmingOffer: boolean;
  multiConstraint: boolean;
  namesADish: boolean;
  wantsDrinks: boolean;
  cartOp: CartOp;
  referentKind: ReferentKind;
  mode: "jev" | "heuristic";
  /** The slot answers from this same call, reusable when there is one chunk. */
  slotAnswers: Record<string, unknown> | null;
};

const ROUTE_QUESTIONS = {
  intent: choice(
    "A guest is talking to a restaurant's menu assistant. Classify what the guest's LATEST message is asking for. Earlier turns are context only -- use them to understand words like 'that one' or 'yes', not to reclassify the older request.",
    {
      structured_query:
        "The guest wants dishes that match stated, checkable attributes: a diet (veg, non-veg, jain, eggetarian, seafood), a cuisine, a course, a spice level, a named protein, alcoholic or non-alcoholic drinks, a drink's strength, or a headcount with preferences. Examples: 'an Indian non-veg item', 'something vegetarian and not spicy', 'for 5 people: 2 veg, 1 spicy non-veg, 2 desserts', 'suggest some alcoholic drinks', 'a strong cocktail', 'a mocktail'.",
      advisory:
        "The guest wants the assistant's judgement rather than a filter: a combo, a whole meal, a pairing, 'what's good here', what to order for an occasion, or a recommendation whose test is subjective -- good, popular, light, impressive, safe, adventurous. Examples: 'suggest a good combo for non-veg', 'what should the three of us get to try the best of the kitchen'.",
      dish_question:
        "The guest is asking a factual question ABOUT a dish or about the menu, rather than asking to be offered dishes. What is in it, is it spicy, does it contain nuts, how large is it, what does it come with. Examples: 'what is in the butter naan', 'is the biryani very hot'.",
      cart_action:
        "The guest is telling the assistant to change the order itself: add a dish, accept a dish that was just offered, remove a dish, change a quantity, read the order back, or clear it. Examples: 'yes, order that one', 'add two butter naan', 'drop the biryani', 'what is in my order so far'.",
      smalltalk:
        "A greeting, thanks, an apology, chit-chat, or anything with nothing to do with this restaurant's food or the order -- opening hours, directions, the weather.",
    },
  ),

  confirming_offer: noul(
    "The guest's latest message accepts, confirms, or points at one or more of the dishes the assistant offered in its previous turn, instead of describing a fresh request. 'Yes', 'that one', 'the first', 'we'll take both', 'the chicken one', 'sounds good, order it' all count as accepting. A message that states a new set of requirements does not count, even if it starts with 'yes'.",
  ),

  multi_constraint: noul(
    "The guest's latest message states more than one distinct requirement that would have to be satisfied by DIFFERENT dishes -- two different diets, or one person's preference plus another person's, or a dish plus a separately described drink. A single requirement described with several adjectives, such as 'a spicy Indian non-veg starter', is ONE requirement, not several.",
  ),

  names_a_dish: noul(
    "The guest's latest message names a specific dish or drink from a menu, by its name or by an unmistakable part of its name.",
  ),

  wants_drinks: noul(
    "The guest's latest message asks for something to drink -- a cocktail, beer, wine, mocktail, juice, tea, coffee -- or for shisha, either instead of or alongside food.",
  ),

  cart_op: choice("The guest wants to change their order. Which change are they asking for?", {
    add: "Put one or more dishes into the order, or accept a dish that was just offered.",
    remove: "Take a dish out of the order.",
    set_quantity: "Keep the dish but change how many of it -- 'make that three', 'just one naan actually'.",
    view: "Read the current order back to them without changing it.",
    clear: "Empty the order entirely and start again.",
  }),

  referent_kind: choice(
    "The guest is pointing at a dish. HOW are they identifying it? Judge only the wording they used.",
    {
      ordinal: "By position in the list they were just shown -- 'the first', 'the second one', 'the last'.",
      by_name: "By naming the dish, or a distinctive word from its name.",
      by_attribute: "By a property rather than a name -- 'the chicken one', 'the veg one', 'the spicy one', 'the cheaper one'.",
      all_offered: "All of what was offered -- 'both', 'all of them', 'everything you said'.",
      bare_yes: "A bare acceptance with no pointer at all -- 'yes', 'ok', 'sure', 'go ahead', 'done'.",
      unclear: "The message does not identify a dish clearly enough to act on.",
    },
  ),

  // The per-chunk slot questions ride along, so a single-constraint request is
  // classified and parsed in the same round trip. Free: output tokens cost
  // nothing and the state is billed once.
  ...CHUNK_QUESTIONS,
} as const;

/* ---------------------------------------------------------------- regex -- */

/**
 * Opens like a question...
 *
 * The optional `'?s` matters more than it looks: guests type "whats in the
 * butter naan" without the apostrophe, and `\bwhat\b` does not match "whats",
 * so the question used to fall through to small talk.
 */
const QUESTION_RE =
  /^\s*(?:(?:what|which|how|why|where|who|when|is|are|was|were|does|do|did|can|could)(?:'?s)?|tell me|explain)\b/i;
/** ...but these mean the guest wants suggestions, not an explanation. */
const REQUEST_RE =
  /\b(recommend|recommendation|suggest|should we (order|get|have)|order for|table for|for \d+ (people|pax|guests)|people|pax|guests)\b/i;
const CART_RE =
  /\b(order|add|take|remove|delete|drop|cancel|my order|cart|checkout|basket)\b/i;
const AFFIRM_RE = /^(yes|yeah|yep|sure|ok|okay|go ahead|do it|order it|sounds good)\b/i;
const CLEAR_RE = /\b(clear|empty|start (over|again)|cancel everything)\b/i;
const VIEW_RE = /\b(what('s| is) in my order|show (me )?my order|my cart|order so far)\b/i;
const ADVISORY_RE = /\b(combo|combination|best|good|popular|nice|surprise|what do you|what should)\b/i;

/**
 * Today's routing, kept verbatim as the fallback.
 *
 * This is the mode that runs on any machine without a TypeSafe key, so it is the
 * one to keep honest: the chat must work without Jev, only less well.
 */
export function routeHeuristic(message: string, session: Session): Route {
  const hasOffer = (session.lastOffer?.dishes.length ?? 0) > 0;
  const plan = heuristicPlan(message);

  let intent: Intent;
  if (VIEW_RE.test(message) || (CART_RE.test(message) && !REQUEST_RE.test(message))) {
    intent = "cart_action";
  } else if (hasOffer && AFFIRM_RE.test(message)) {
    intent = "cart_action";
  } else if (QUESTION_RE.test(message) && !REQUEST_RE.test(message) && !ADVISORY_RE.test(message)) {
    intent = "dish_question";
  } else if (ADVISORY_RE.test(message) && plan.slots.length <= 1) {
    // "Suggest a good combo for non-veg" states a constraint AND asks for
    // judgement. One constraint plus a judgement word is a request to compose;
    // several constraints is a seating plan, and goes to the slot engine even
    // when it opens with "recommendations for".
    intent = "advisory";
  } else if (plan.slots.length > 0) {
    intent = "structured_query";
  } else if (REQUEST_RE.test(message) || ADVISORY_RE.test(message)) {
    intent = "advisory";
  } else {
    intent = "smalltalk";
  }

  const cartOp: CartOp = CLEAR_RE.test(message)
    ? "clear"
    : VIEW_RE.test(message)
      ? "view"
      : /\b(remove|delete|drop|cancel)\b/i.test(message)
        ? "remove"
        : "add";

  return {
    intent,
    confidence: 1,
    confirmingOffer: hasOffer && AFFIRM_RE.test(message),
    multiConstraint: plan.slots.length > 1,
    namesADish: false,
    wantsDrinks: /cocktail|drink|wine|beer|mocktail|juice|shisha|hookah|alcohol|booz|liquor|whisk|vodka|\bgin\b|\brum\b|tequila|\bshots?\b/i.test(message),
    cartOp,
    referentKind: AFFIRM_RE.test(message) ? "bare_yes" : "by_name",
    mode: "heuristic",
    slotAnswers: null,
  };
}

/* ------------------------------------------------------------------ main -- */

/**
 * The state Jev sees. Never the menu -- only the conversation, a few hundred
 * tokens against a 64k ceiling. `dishes_just_offered` is what makes "yes, the
 * first one" resolvable at all.
 */
function buildState(message: string, session: Session) {
  return {
    guest_message: message,
    conversation: session.turns
      .slice(-4)
      .map((t) => `${t.role}: ${t.text.slice(0, 200)}`),
    dishes_just_offered: (session.lastOffer?.dishes ?? []).map(
      (d) => `${d.ordinal}. ${d.name}`,
    ),
    order_so_far: session.cart.map((l) => `${l.qty} x ${l.name}`),
  };
}

export async function classify(message: string, session: Session): Promise<Route> {
  const answers = await askJev(buildState(message, session), ROUTE_QUESTIONS);
  if (!answers) return routeHeuristic(message, session);

  const intentAnswer = answers.intent;
  // An unconfident five-way partition is worse than the regex, which at least
  // fails in ways we have seen before.
  if (!intentAnswer || intentAnswer.confidence < env.JEV_MIN_CONFIDENCE) {
    const fallback = routeHeuristic(message, session);
    return { ...fallback, confidence: intentAnswer?.confidence ?? 0 };
  }

  const slotAnswers = {
    diet: answers.diet,
    cuisine: answers.cuisine,
    course: answers.course,
    mentions_spice: answers.mentions_spice,
    spice: answers.spice,
    is_drink: answers.is_drink,
  };

  return {
    intent: intentAnswer.choice as Intent,
    confidence: intentAnswer.confidence,
    confirmingOffer: isTrue(answers.confirming_offer),
    multiConstraint: isTrue(answers.multi_constraint),
    namesADish: isTrue(answers.names_a_dish),
    wantsDrinks: isTrue(answers.wants_drinks),
    cartOp: decided<CartOp>(answers.cart_op, "add"),
    referentKind: decided<ReferentKind>(answers.referent_kind, "unclear"),
    mode: "jev",
    slotAnswers,
  };
}

export { score };
