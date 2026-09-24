import { env } from "../lib/env.ts";
import {
  recordOffer,
  recordTurn,
  type OfferedDish,
  type Session,
} from "../lib/session.ts";
import type { ChatInput } from "../schemas/menu.schema.ts";
import { ask } from "./menu.ask.service.ts";
import { advise } from "./menu.advise.service.ts";
import { composeCombos, type Combo } from "./menu.combo.service.ts";
import * as cart from "./menu.cart.service.ts";
import type { PublicItem } from "./menu.items.service.ts";
import { nameKey, quantityIn, resolve } from "./menu.reference.ts";
import { recommend } from "./menu.recommend.service.ts";
import { classify, type Route } from "./menu.route.service.ts";
import { fallbackSlot, heuristicPlan, partySize, planSlots, splitChunks } from "./menu.slots.service.ts";
import { resolveDish } from "./menu.sql.service.ts";

/**
 * One door for the chat UI.
 *
 * Jev classifies the turn; everything downstream is a consequence of that
 * verdict. The frontend sends a message and renders whichever `kind` comes back.
 *
 * Every branch that puts dishes in front of a guest records them on the session
 * with ordinals, because that is the only thing that makes the NEXT turn's
 * "yes, the first one" answerable.
 */

export type ChatResult =
  | Awaited<ReturnType<typeof recommend>> & { kind: "recommendations" }
  | { kind: "advice"; query: string; answer: string; groups: unknown[]; warnings: unknown[]; chips: string[]; meta: Meta }
  | { kind: "combos"; query: string; answer: string; combos: Combo[]; warnings: unknown[]; chips: string[]; meta: Meta }
  | { kind: "answer"; query: string; answer: string; dishes: PublicItem[]; chips: string[]; meta: Meta }
  | { kind: "cart"; query: string; action: string; answer: string; changed: PublicItem[]; cart: cart.CartView; chips: string[]; meta: Meta }
  | { kind: "clarify"; query: string; answer: string; options: { label: string; message: string; item: PublicItem }[]; chips: string[]; meta: Meta };

type Meta = {
  route: string;
  routeMode: "jev" | "heuristic";
  slotMode?: "jev" | "heuristic";
  intentConfidence: number;
  chatModel: string;
  tookMs: number;
  sessionId: string;
};

function toOffered(item: PublicItem): Omit<OfferedDish, "ordinal"> {
  return {
    id: item.id,
    name: item.name,
    nameKey: nameKey(item.name),
    diet: item.diet,
    protein: item.protein,
    spice: item.spice,
    spiceConfidence: item.spiceConfidence,
    price: item.price,
  };
}

export async function chat(input: ChatInput, session: Session): Promise<ChatResult> {
  const started = Date.now();
  const route = await classify(input.message, session);

  recordTurn(session, "guest", input.message);

  const meta = (extra: Partial<Meta> = {}): Meta => ({
    route: route.intent,
    routeMode: route.mode,
    intentConfidence: Number(route.confidence.toFixed(3)),
    chatModel: env.MISTRAL_CHAT_MODEL,
    tookMs: Date.now() - started,
    sessionId: session.id,
    ...extra,
  });

  // A confirmation is checked BEFORE the intent, not after. "Yes, and make it
  // two" often scores as a structured query on the five-way partition while the
  // yes/no question is unambiguous -- a single proposition is the more reliable
  // signal for this one case.
  const isCart =
    route.intent === "cart_action" ||
    (route.confirmingOffer && (session.lastOffer?.dishes.length ?? 0) > 0);

  // Several separately-counted constraints is a seating plan, even when it is
  // phrased like a request for judgement ("the 3 of us: 1 veg, 1 italian").
  // Advice would compose one combo and drop the per-person split.
  // Likewise "suggest some alcoholic drinks": alcoholic vs not is a hard filter
  // the advice path cannot apply, and it would hand back mocktails.
  const heuristicSlots = route.intent === "advisory" ? heuristicPlan(input.message).slots : [];
  const isSeatingPlan =
    heuristicSlots.length > 1 ||
    heuristicSlots.some((s) => s.course === "Alcohol" || s.course === "Beverage");

  const result = isCart
    ? await handleCart(input, session, route, meta)
    : route.intent === "advisory" && !isSeatingPlan
      ? await handleAdvice(input, session, route, meta)
      : route.intent === "dish_question"
        ? await handleQuestion(input, session, route, meta)
        : route.intent === "smalltalk"
          ? handleSmalltalk(input, meta)
          : await handleStructured(input, session, route, meta);

  recordTurn(session, "bot", summarise(result));
  return result;
}

/* ------------------------------------------------------------ structured -- */

async function handleStructured(
  input: ChatInput,
  session: Session,
  route: Route,
  meta: (e?: Partial<Meta>) => Meta,
): Promise<ChatResult> {
  const { plan, mode } = route.mode === "jev"
    ? await planSlots(input.message, {
        preAnswers: route.slotAnswers,
        multi: route.multiConstraint,
      })
    : { plan: heuristicPlan(input.message), mode: "heuristic" as const };

  // "What should we order for four" states no constraint at all, but is plainly
  // a request for suggestions. Hand it to the advisory path rather than
  // answering "no constraints found".
  if (plan.slots.length === 0) {
    const size = partySize(input.message);
    if (size > 0 || splitChunks(input.message).length <= 1) {
      return handleAdvice(input, session, route, meta);
    }
    plan.slots.push(fallbackSlot(size));
  }

  const result = await recommend(
    {
      query: input.message,
      perSlot: input.perSlot,
      includeDrinks: input.includeDrinks || route.wantsDrinks,
    },
    { plan, mode },
  );

  recordOffer(
    session,
    "recommendations",
    result.groups.flatMap((g) => g.recommendations.map((r) => toOffered(r.item as PublicItem))),
  );

  return { kind: "recommendations", ...result, meta: meta({ slotMode: mode }) } as ChatResult;
}

/* --------------------------------------------------------------- advice -- */

/**
 * A request to be handed a meal rather than an opinion. "Suggest a combo",
 * "what should the three of us order" -- these get three combos with
 * adjustable quantities. "Is the biryani good?" never reaches here (it is a
 * dish question), and "what's good here" stays prose.
 */
const COMBO_RE =
  /\bcombos?\b|combination|\bmeals?\b|\bthali\b|what should (we|i|the \w+ of us) (order|get|have|eat)|\b(suggest|recommend)\b|order for|feed us/i;

async function handleAdvice(
  input: ChatInput,
  session: Session,
  route: Route,
  meta: (e?: Partial<Meta>) => Meta,
): Promise<ChatResult> {
  // Reuse whatever the routing call already read out of the message, so "a good
  // non-veg combo" is pre-filtered to non-veg before the model ever sees it.
  const plan = heuristicPlan(input.message);
  const diet = plan.slots.find((s) => s.diet !== "any")?.diet
    ?? (route.slotAnswers ? planDietFromRoute(route) : undefined);

  if (COMBO_RE.test(input.message)) {
    return handleCombos(input, session, route, meta, diet);
  }

  const result = await advise(input.message, {
    diet,
    includeDrinks: input.includeDrinks || route.wantsDrinks,
  });

  recordOffer(session, "advice", result.picks.map((p) => toOffered(p.item)));

  // Reuses the RecommendationGroup shape so the existing GroupBlock renders it
  // with no frontend change beyond widening one conditional.
  const groups = result.picks.length
    ? [{
        id: "combo",
        label: diet && diet !== "any" ? `A ${diet} combination` : "A combination",
        count: Math.max(1, partySize(input.message) || 1),
        constraints: { diet: diet ?? "any", spice: "any", cuisine: "any", course: "any", courseGroup: "food" },
        searchText: input.message,
        relaxations: [],
        shortfall: 0,
        recommendations: result.picks.map((p, i) => ({
          rank: i + 1,
          score: 1 - i * 0.01,
          why: p.why || p.role,
          item: p.item,
        })),
      }]
    : [];

  return {
    kind: "advice",
    query: input.message,
    answer: result.answer,
    groups,
    warnings: result.warnings,
    chips: ["Something spicier", "Anything vegetarian?", "Add the first one"],
    meta: meta(),
  };
}

async function handleCombos(
  input: ChatInput,
  session: Session,
  route: Route,
  meta: (e?: Partial<Meta>) => Meta,
  diet: string | undefined,
): Promise<ChatResult> {
  const result = await composeCombos(input.message, {
    diet,
    partySize: partySize(input.message),
    includeDrinks: input.includeDrinks || route.wantsDrinks,
  });

  // Flattened in the order the UI shows them, so "add the kulcha" still
  // resolves through the ordinary offer machinery.
  recordOffer(
    session,
    "combos",
    result.combos.flatMap((c) => c.items.map((i) => toOffered(i.item))),
  );
  session.lastCombos = result.combos.map((c) => ({
    title: c.title,
    lines: c.items.map((i) => ({ itemId: i.item.id, qty: i.qty })),
  }));

  return {
    kind: "combos",
    query: input.message,
    answer: result.answer,
    combos: result.combos,
    warnings: result.warnings,
    chips: result.combos.length
      ? ["Add combo 1", "Something vegetarian", "Show my order"]
      : ["What should we order for four?", "Anything vegetarian?"],
    meta: meta(),
  };
}

function planDietFromRoute(route: Route): string | undefined {
  const answer = (route.slotAnswers as { diet?: { choice?: string; confidence?: number } } | null)?.diet;
  if (!answer?.choice || (answer.confidence ?? 0) < env.JEV_DIET_MIN_CONFIDENCE) return undefined;
  return answer.choice === "any" ? undefined : answer.choice;
}

/* ------------------------------------------------------------- question -- */

async function handleQuestion(
  input: ChatInput,
  session: Session,
  route: Route,
  meta: (e?: Partial<Meta>) => Meta,
): Promise<ChatResult> {
  const { answer, dishes, chips } = await ask(input.message, {
    named: route.namesADish || route.mode === "heuristic",
    includeDrinks: input.includeDrinks || route.wantsDrinks,
  });

  // "Is the biryani spicy?" then "ok, order it" has to work.
  recordOffer(session, "answer", dishes.map(toOffered));

  return { kind: "answer", query: input.message, answer, dishes, chips, meta: meta() };
}

/* ----------------------------------------------------------- smalltalk -- */

function handleSmalltalk(input: ChatInput, meta: (e?: Partial<Meta>) => Meta): ChatResult {
  return {
    kind: "answer",
    query: input.message,
    answer:
      "I can only really help with tonight's menu and your order. Tell me who is eating and what they like, and I will find something.",
    dishes: [],
    chips: ["What should we order for four?", "Something spicy", "Anything vegetarian?"],
    meta: meta(),
  };
}

/* ----------------------------------------------------------------- cart -- */

async function handleCart(
  input: ChatInput,
  session: Session,
  route: Route,
  meta: (e?: Partial<Meta>) => Meta,
): Promise<ChatResult> {
  const done = async (action: string, answer: string, changed: PublicItem[] = []) => ({
    kind: "cart" as const,
    query: input.message,
    action,
    answer,
    changed,
    cart: await cart.view(session),
    chips: ["What else do you have?", "Show my order", "Something to drink"],
    meta: meta(),
  });

  // "Add combo 2" -- at the quantities suggested, since a chat message cannot
  // carry the stepper state the UI button sends.
  const comboIndex = comboNumber(input.message);
  if (comboIndex != null && session.lastCombos?.[comboIndex] && route.cartOp !== "remove") {
    const combo = session.lastCombos[comboIndex]!;
    const added = await cart.addMany(session, combo.lines);
    const current = await cart.view(session);
    return done(
      "added",
      `Added the ${combo.title} combo: ${combo.lines
        .map((l) => `${l.qty} x ${added.find((a) => a.id === l.itemId)?.name ?? "item"}`)
        .join(", ")}. That is ${current.totalItems} item${current.totalItems === 1 ? "" : "s"} so far` +
        (current.subtotal != null ? `, ₹${Math.round(current.subtotal)}.` : "."),
      added,
    );
  }

  if (route.cartOp === "view") {
    const current = await cart.view(session);
    return done(
      "viewed",
      current.lines.length === 0
        ? "Your order is empty so far."
        : `You have ${current.lines.map((l) => `${l.qty} x ${l.item.name}`).join(", ")}.` +
            (current.subtotal != null ? ` That is ₹${Math.round(current.subtotal)}.` : ""),
    );
  }

  if (route.cartOp === "clear") {
    cart.clear(session);
    return done("cleared", "Cleared your order. What would you like instead?");
  }

  const resolution = resolve(
    input.message,
    session.lastOffer,
    session.turns.length,
    route.referentKind,
  );

  let dishes = resolution.status === "resolved" ? resolution.dishes : [];

  // Nothing in the last offer matched, so look across the whole menu -- the
  // guest may be naming a dish we never suggested.
  if (resolution.status === "not_on_menu" || resolution.status === "no_context") {
    const found = await resolveDish(resolution.status === "not_on_menu" ? resolution.term : input.message);

    if (found.status === "resolved") {
      dishes = [{ ...toOffered(found.item), ordinal: 1 }];
    } else if (found.status === "ambiguous") {
      return clarify(input, found.candidates, "Which one did you mean?", meta);
    } else {
      return {
        kind: "answer",
        query: input.message,
        answer:
          resolution.status === "no_context"
            ? "I have not offered anything yet -- what are you in the mood for?"
            : `I cannot find "${resolution.term}" on tonight's menu.`,
        dishes: [],
        chips: ["What should we order for four?", "Something spicy", "Anything vegetarian?"],
        meta: meta(),
      };
    }
  }

  if (resolution.status === "ambiguous") {
    const items = await hydrate(resolution.candidates.map((c) => c.id));
    return clarify(input, items, `Which one -- ${resolution.because}?`, meta);
  }

  if (dishes.length === 0) {
    return done("viewed", "I am not sure which dish you meant. Which one would you like?");
  }

  if (route.cartOp === "remove") {
    const removed: PublicItem[] = [];
    for (const dish of dishes) {
      try {
        cart.remove(session, dish.id);
        removed.push(...(await hydrate([dish.id])));
      } catch {
        // Not in the cart. Saying so is better than a silent no-op.
      }
    }
    return removed.length
      ? done("removed", `Took ${removed.map((d) => d.name).join(" and ")} out of your order.`, removed)
      : done("viewed", `${dishes.map((d) => d.name).join(" and ")} was not in your order.`);
  }

  const qty = quantityIn(input.message);
  const added: PublicItem[] = [];
  for (const dish of dishes) {
    if (route.cartOp === "set_quantity") {
      try {
        cart.setQuantity(session, dish.id, qty);
      } catch {
        await cart.add(session, dish.id, qty);
      }
    } else {
      await cart.add(session, dish.id, qty);
    }
    added.push(...(await hydrate([dish.id])));
  }

  const names = added.map((d) => d.name).join(" and ");
  const current = await cart.view(session);
  return done(
    route.cartOp === "set_quantity" ? "updated" : "added",
    `${route.cartOp === "set_quantity" ? "Set" : "Added"} ${qty > 1 ? `${qty} x ` : ""}${names}. ` +
      `That is ${current.totalItems} item${current.totalItems === 1 ? "" : "s"} so far` +
      (current.subtotal != null ? `, ₹${Math.round(current.subtotal)}.` : "."),
    added,
  );
}

const COMBO_ORDINALS: Record<string, number> = {
  "1": 0, one: 0, first: 0, "2": 1, two: 1, second: 1, "3": 2, three: 2, third: 2,
};

/** "combo 2", "the second combo", "combo two" -> 1. Null when no combo is named. */
function comboNumber(message: string): number | null {
  const text = message.toLowerCase();
  const m =
    /\bcombo\s*(?:no\.?\s*|number\s*|#\s*)?(\d|one|two|three)\b/.exec(text) ??
    /\b(first|second|third|\d|one|two|three)\s+combo\b/.exec(text);
  return m ? COMBO_ORDINALS[m[1]!] ?? null : null;
}

/**
 * Loads dishes by id, in the order asked for.
 *
 * `findMany` returns rows in whatever order Postgres likes, which would shuffle
 * the clarify options out of the order the guest was originally shown them --
 * so "the first one" would mean something different in the follow-up.
 */
async function hydrate(ids: string[]): Promise<PublicItem[]> {
  const { prisma } = await import("../../db/index.ts");
  const { toPublicItem } = await import("./menu.items.service.ts");
  const rows = await prisma.item.findMany({ where: { id: { in: ids } } });
  const byId = new Map(rows.map((r) => [r.id, toPublicItem(r)]));
  return ids.map((id) => byId.get(id)).filter((i): i is PublicItem => Boolean(i));
}

/**
 * Never guess between two dishes on an order confirmation.
 *
 * Each option's `message` is a literal follow-up, so clicking one comes back as
 * a message that resolves on an exact name match rather than landing here again.
 */
function clarify(
  input: ChatInput,
  items: PublicItem[],
  because: string,
  meta: (e?: Partial<Meta>) => Meta,
): ChatResult {
  const options = items.slice(0, 5).map((item) => ({
    label: item.name,
    message: `add the ${item.name}`,
    item,
  }));

  return {
    kind: "clarify",
    query: input.message,
    answer: `${because} ${options.map((o) => o.label).join(", or ")}?`,
    options,
    chips: options.map((o) => o.message),
    meta: meta(),
  };
}

/* ---------------------------------------------------------------- misc -- */

function summarise(result: ChatResult): string {
  switch (result.kind) {
    case "recommendations": {
      const n = result.groups.reduce((acc, g) => acc + g.recommendations.length, 0);
      return `offered ${n} dishes across ${result.groups.length} group(s)`;
    }
    case "advice":
      return `suggested a combination: ${result.answer.slice(0, 120)}`;
    case "combos":
      return `offered ${result.combos.length} combos: ${result.combos
        .map((c, i) => `${i + 1}. ${c.title} (${c.items.map((x) => x.item.name).join(", ")})`)
        .join("; ")}`.slice(0, 380);
    case "cart":
      return `${result.action}: ${result.answer.slice(0, 120)}`;
    case "clarify":
      return `asked which dish: ${result.options.map((o) => o.label).join(", ")}`;
    default:
      return result.answer.slice(0, 160);
  }
}
