import * as copy from "../domain/concierge.copy.ts";
import {
  occasionKind,
  parseReservation,
  type HardStopCategory,
  type ReservationField,
} from "../domain/concierge.detect.ts";
import { env } from "../lib/env.ts";
import type { PendingReservation, Session } from "../lib/session.ts";
import {
  prismaFeedbackStore,
  submitFeedback,
  takeName,
  type FeedbackStore,
  type Guest,
} from "./feedback.service.ts";
import type { Route } from "./menu.route.service.ts";

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

  /* ---- 1. hard stop: say one line, then go silent ---------------------- */

  if (route.hardStop || (route.angry && session.apologisedAt)) {
    const category: HardStopCategory = route.hardStop ?? "persistent_anger";
    session.mutedAt = Date.now();
    session.pendingReservation = null;
    session.pendingManagerOffer = false;
    await log("hard_stop", { category });
    return reply(copy.HANDOFF, [], { action: "handoff", muted: true });
  }

  /* ---- 2. answers to something we just asked ---------------------------- */

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

  /* ---- 4. requests of the floor ---------------------------------------- */

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

  /* ---- 5. a returning guest who has been away a long time --------------- */

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
