import * as copy from "../domain/concierge.copy.ts";
import {
  isDislike,
  occasionKind,
  pointsAtIt,
  parseReservation,
  reviewAsksForDishes,
  reviewedDish,
  reviewSentiment,
  type HardStopCategory,
  type ReservationField,
} from "../domain/concierge.detect.ts";
import { env } from "../lib/env.ts";
import type { CartLine, PendingReservation, Session } from "../lib/session.ts";
import {
  prismaFeedbackStore,
  submitFeedback,
  takeName,
  type FeedbackStore,
  type Guest,
} from "./feedback.service.ts";
import type { ReviewSentiment, Route } from "./menu.route.service.ts";

/**
 * Everything the guest asks of the floor rather than of the menu.
 *
 * Runs before the menu paths on every turn. Returns one of:
 *   - a `reply`, which is the whole answer to the turn;
 *   - a `preface`, one warm line said ahead of the menu answer ("Happy
 *     birthday" before the dessert suggestions);
 *   - null, when the turn is purely about food.
 *
 * Requests are written to `guest_requests` so the floor can act on them. Nothing
 * pages a human yet, so no reply here promises a time.
 */

export type ConciergeReply = {
  answer: string;
  chips: string[];
  /** A hint for the UI: "handoff", "open_feedback_form", "reservation_requested"... */
  action?: string;
  /** The assistant is silent from here on; a human has the table. */
  muted?: boolean;
  /** The guest said yes to taking this dish off the order. The chat service removes it. */
  removeItemId?: string;
};

export type ConciergeOutcome = { reply: ConciergeReply } | { preface: string } | null;

type RequestType = "hard_stop" | "issue" | "call_manager" | "call_captain" | "reservation" | "music";

export type ConciergeStore = FeedbackStore & {
  logRequest(row: {
    type: RequestType;
    sessionId: string;
    userId: string | null;
    message: string;
    details?: Record<string, unknown>;
  }): Promise<void>;
  touchVisit(userId: string): Promise<void>;
  /** `dish` is the guest's words for it; the store links it to a menu row if it can. */
  logReview(row: {
    sessionId: string;
    userId: string | null;
    message: string;
    sentiment: ReviewSentiment;
    dish: string | null;
  }): Promise<void>;
};

export const prismaConciergeStore: ConciergeStore = {
  ...prismaFeedbackStore,

  async logRequest(row) {
    const { prisma } = await import("../../db/index.ts");
    await prisma.guestRequest.create({
      data: {
        type: row.type,
        sessionId: row.sessionId,
        userId: row.userId,
        message: row.message,
        details: row.details as never,
      },
    });
  },

  async touchVisit(userId) {
    const { prisma } = await import("../../db/index.ts");
    await prisma.user.update({ where: { id: userId }, data: { lastVisitAt: new Date() } });
  },

  async logReview(row) {
    const { prisma } = await import("../../db/index.ts");
    const { resolveDish } = await import("./menu.sql.service.ts");
    // "pasta" with four pastas on the menu is left as the guest's word rather
    // than pinned on one of them -- a review filed against the wrong dish is
    // worse than one filed against none.
    const match = row.dish ? await resolveDish(row.dish).catch(() => null) : null;
    const item = match?.status === "resolved" ? match.item : null;
    await prisma.review.create({
      data: {
        sessionId: row.sessionId,
        userId: row.userId,
        message: row.message,
        sentiment: row.sentiment,
        itemId: item?.id ?? null,
        itemName: item?.name ?? row.dish,
      },
    });
  },
};

/** The logged-in guest behind a chat, if any. Never throws: a guest can always chat anonymously. */
export async function loadGuest(auth: { id: string; role: string } | undefined): Promise<Guest> {
  if (!auth || auth.role !== "user") return null;
  try {
    const { prisma } = await import("../../db/index.ts");
    const user = await prisma.user.findUnique({
      where: { id: auth.id },
      select: { id: true, name: true, lastVisitAt: true },
    });
    return user ? { userId: user.id, name: user.name, lastVisitAt: user.lastVisitAt } : null;
  } catch (err) {
    console.warn(`[concierge] guest lookup failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** Exact button labels, compared loosely so "not now." and "Not now" both count. */
const said = (message: string, label: string) =>
  message.trim().toLowerCase().replace(/[.!\s]+$/, "") === label.toLowerCase();

const YES_RE = /^\s*(yes|yeah|yep|yup|please|sure|ok(ay)?|go ahead|haan|ha)\b/i;
const NO_RE = /^\s*(no|nope|nah|not (now|needed|necessary)|it'?s (fine|ok(ay)?)|that'?s (fine|ok(ay)?))\b/i;

const reply = (answer: string, chips: string[] = [], extra: Partial<ConciergeReply> = {}) => ({
  reply: { answer, chips, ...extra },
});

export async function handleConcierge(
  message: string,
  session: Session,
  route: Route,
  guest: Guest,
  store: ConciergeStore = prismaConciergeStore,
): Promise<ConciergeOutcome> {
  const log = async (type: RequestType, details?: Record<string, unknown>) => {
    try {
      await store.logRequest({ type, sessionId: session.id, userId: guest?.userId ?? null, message, details });
    } catch (err) {
      // The guest still gets an answer. Losing the row is bad; a 500 to someone
      // reporting food poisoning is worse.
      console.warn(`[concierge] could not log ${type}: ${err instanceof Error ? err.message : err}`);
    }
  };
  const saveReview = async (words: string, sentiment: ReviewSentiment, dish: string | null) => {
    try {
      await store.logReview({ sessionId: session.id, userId: guest?.userId ?? null, message: words, sentiment, dish });
    } catch (err) {
      console.warn(`[concierge] could not log review: ${err instanceof Error ? err.message : err}`);
    }
  };

  /* ---- 1. hard stop: say one line, then go silent ---------------------- */

  if (route.hardStop || (route.angry && session.apologisedAt)) {
    const category: HardStopCategory = route.hardStop ?? "persistent_anger";
    session.mutedAt = Date.now();
    session.pendingReservation = null;
    session.pendingManagerOffer = false;
    session.pendingRemoval = null;
    await log("hard_stop", { category });
    return reply(copy.HANDOFF, [], { action: "handoff", muted: true });
  }

  /* ---- 2. answers to something we just asked ---------------------------- */

  if (session.pendingRemoval) {
    const pending = session.pendingRemoval;
    session.pendingRemoval = null;
    // "No" is read first: "no, don't remove it" contains "remove".
    const keep =
      said(message, copy.REMOVE_BUTTONS[1]) ||
      NO_RE.test(message) ||
      /\b(keep|leave|do ?n'?t|do not)\b/i.test(message);
    const remove =
      !keep &&
      (said(message, copy.REMOVE_BUTTONS[0]) || YES_RE.test(message) || /\b(remove|take it off)\b/i.test(message));
    if (remove) {
      return reply(copy.REMOVE_DONE(pending.name), ["Show my order", "What else do you have?"], {
        action: "remove_confirmed",
        removeItemId: pending.itemId,
      });
    }
    // Anything but a yes keeps the dish, and what they said becomes a review.
    const sentiment = reviewSentiment(pending.message);
    await saveReview(pending.message, sentiment === "positive" ? "negative" : sentiment, pending.name);
    if (keep) {
      return reply(copy.REMOVE_KEPT, [], { action: "review_logged" });
    }
    // They moved on without answering. The dish stays; this message is read afresh.
  }

  if (session.pendingManagerOffer) {
    session.pendingManagerOffer = false;
    if (said(message, copy.MANAGER_OFFER_BUTTONS[0]) || YES_RE.test(message)) {
      await log("call_manager", { reason: "low_feedback" });
      return reply(copy.MANAGER_YES, [], { action: "manager_requested" });
    }
    if (said(message, copy.MANAGER_OFFER_BUTTONS[1]) || NO_RE.test(message)) {
      // Declining a visit is not withdrawing the complaint; the feedback row
      // already carries `escalate`.
      return reply(copy.MANAGER_NO);
    }
  }

  if (said(message, copy.FEEDBACK_BUTTONS[2])) {
    // "Not now" is honoured silently. That one button is what keeps this number
    // from being reported as spam.
    session.feedbackDeclined = true;
    return reply("", [], { action: "feedback_declined" });
  }
  if (said(message, copy.FEEDBACK_BUTTONS[1])) {
    if (session.feedbackSubmitted) return reply(copy.FEEDBACK_ALREADY);
    const r = await submitFeedback(
      session,
      guest,
      { overall: 5, food: 5, service: 5, ambience: 5, cleanliness: 5, comment: undefined },
      { quick: true, store },
    );
    return reply(r.answer, r.chips, { action: "feedback_submitted" });
  }
  if (said(message, copy.FEEDBACK_BUTTONS[0])) {
    if (session.feedbackSubmitted) return reply(copy.FEEDBACK_ALREADY);
    return reply("", [], { action: "open_feedback_form" });
  }

  if (session.pendingReservation) {
    const next = await continueReservation(message, session, route, log);
    if (next) return next;
  }

  /* ---- 3. first anger gets the one apology ------------------------------ */

  if (route.angry) {
    session.apologisedAt = Date.now();
    await log("issue", { angry: true });
    return reply(copy.ANGER_APOLOGY, [], { action: "issue_logged" });
  }

  /* ---- 4. a dish on the order they have turned against ----------------- */

  // Asked, never done: a complaint is not an instruction to change the bill.
  const disliked = isDislike(message) ? dislikedCartLine(message, session) : null;
  if (disliked) {
    session.pendingRemoval = { itemId: disliked.itemId, name: disliked.name, message };
    return reply(copy.REMOVE_CONFIRM(disliked.name), [...copy.REMOVE_BUTTONS], { action: "remove_confirm" });
  }

  /* ---- 5. requests of the floor ---------------------------------------- */

  const prefaces: string[] = [];
  const standalone = route.intent === "smalltalk";

  switch (route.conciergeTopic) {
    case "issue":
      await log("issue");
      return reply(copy.ISSUE_ACK, [], { action: "issue_logged" });

    case "call_manager":
      await log("call_manager");
      return reply(copy.CALL_MANAGER, [], { action: "manager_requested" });

    case "call_captain":
      await log("call_captain");
      return reply(copy.CALL_CAPTAIN, [], { action: "captain_requested" });

    case "music_request":
      await log("music");
      return reply(copy.MUSIC_REQUEST, [], { action: "music_requested" });

    case "reservation": {
      session.pendingReservation = { message, ...parseReservation(message) };
      return askOrFileReservation(session, log);
    }

    case "feedback":
      if (session.feedbackSubmitted) return reply(copy.FEEDBACK_ALREADY);
      return reply(copy.FEEDBACK_ASK(takeName(session, guest)), [...copy.FEEDBACK_BUTTONS], {
        action: "feedback_ask",
      });

    case "review": {
      await saveReview(message, route.reviewSentiment, reviewedDish(message));
      // "The pasta was bland -- something spicier?" still gets its dishes.
      if (reviewAsksForDishes(message)) {
        prefaces.push(copy.REVIEW_NOTED);
        break;
      }
      const chips = route.reviewSentiment === "negative" ? [...copy.REVIEW_NEGATIVE_CHIPS] : [];
      return reply(copy.REVIEW_THANKS[route.reviewSentiment], chips, { action: "review_logged" });
    }

    case "farewell":
      if (session.delights?.farewell) return reply(copy.FAREWELL_AGAIN);
      session.delights = { ...session.delights, farewell: true };
      return reply(copy.CLOSING(takeName(session, guest)), [], { action: "closing" });

    case "occasion":
      if (!session.delights?.occasion) {
        session.delights = { ...session.delights, occasion: true };
        const line = copy.OCCASION[occasionKind(message)](takeName(session, guest));
        // One warm line and no upsell -- unless they also asked for something.
        if (standalone) return reply(line);
        prefaces.push(line);
      }
      break;

    case "waiting_for_friends":
      if (!session.delights?.waiting) {
        session.delights = { ...session.delights, waiting: true };
        if (standalone) return reply(copy.WAITING_FOR_FRIENDS, [...copy.WAITING_CHIPS]);
        prefaces.push(copy.WAITING_FOR_FRIENDS);
      }
      break;

    case "none":
      break;
  }

  /* ---- 6. a returning guest who has been away a long time --------------- */

  if (guest && !session.delights?.longGap) {
    session.delights = { ...session.delights, longGap: true };
    const away = guest.lastVisitAt ? Date.now() - guest.lastVisitAt.getTime() : 0;
    store.touchVisit(guest.userId).catch((err) =>
      console.warn(`[concierge] could not record visit: ${err instanceof Error ? err.message : err}`),
    );
    if (away > env.LONG_GAP_DAYS * 24 * 60 * 60_000) {
      if (standalone && prefaces.length === 0) {
        return reply(copy.LONG_GAP, ["What's good tonight?"]);
      }
      prefaces.push(copy.LONG_GAP);
    }
  }

  return prefaces.length ? { preface: prefaces.join(" ") } : null;
}

/* ---------------------------------------------------------------- dislike -- */

const FILLER = new Set(["the", "this", "that", "one", "your", "our", "my"]);

/**
 * The order line a dislike is about: the one it names, or -- for "I don't like
 * it" -- the dish added most recently. Null when it names nothing on the order,
 * in which case it is just a review.
 */
export function dislikedCartLine(message: string, session: Session): CartLine | null {
  if (session.cart.length === 0) return null;
  const newest = [...session.cart].sort((a, b) => b.addedAt - a.addedAt);
  const phrase = reviewedDish(message);
  if (!phrase) return pointsAtIt(message) ? newest[0]! : null;

  const words = phrase
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2 && !FILLER.has(w))
    .map((w) => w.replace(/e?s$/, ""));
  if (words.length === 0) return pointsAtIt(message) ? newest[0]! : null;
  return newest.find((line) => words.every((w) => line.name.toLowerCase().includes(w))) ?? null;
}

/* ------------------------------------------------------------ reservation -- */

type Log = (type: RequestType, details?: Record<string, unknown>) => Promise<void>;

function missingField(r: PendingReservation): ReservationField | null {
  if (!r.dateText) return "date";
  if (!r.timeText) return "time";
  if (!r.partySize) return "partySize";
  return null;
}

/** Asks for one missing thing at a time, or files the request once it has all three. */
async function askOrFileReservation(session: Session, log: Log): Promise<ConciergeOutcome> {
  const pending = session.pendingReservation!;
  const missing = missingField(pending);
  if (missing) return reply(copy.RESERVATION_ASK[missing], [], { action: "reservation_collecting" });

  session.pendingReservation = null;
  // Never confirmed here. The desk confirms; the assistant only asks.
  await log("reservation", {
    dateText: pending.dateText,
    timeText: pending.timeText,
    partySize: pending.partySize,
    firstMessage: pending.message,
  });
  return reply(copy.RESERVATION_TAKEN, [], { action: "reservation_requested" });
}

/**
 * The guest is answering "which day / what time / how many". If this message
 * adds nothing to the booking and is plainly about something else, the booking
 * is dropped rather than asked about again -- they changed the subject.
 */
async function continueReservation(
  message: string,
  session: Session,
  route: Route,
  log: Log,
): Promise<ConciergeOutcome> {
  const pending = session.pendingReservation!;
  const parsed = parseReservation(message, missingField(pending) ?? undefined);

  const merged: PendingReservation = {
    ...pending,
    dateText: pending.dateText ?? parsed.dateText,
    timeText: pending.timeText ?? parsed.timeText,
    partySize: pending.partySize ?? parsed.partySize,
  };
  const progressed =
    merged.dateText !== pending.dateText ||
    merged.timeText !== pending.timeText ||
    merged.partySize !== pending.partySize;

  if (progressed || route.conciergeTopic === "reservation") {
    session.pendingReservation = merged;
    return askOrFileReservation(session, log);
  }

  session.pendingReservation = null;
  return null;
}
