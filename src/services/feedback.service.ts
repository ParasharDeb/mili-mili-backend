import * as copy from "../domain/concierge.copy.ts";
import { env } from "../lib/env.ts";
import { conflict } from "../lib/errors.ts";
import type { Session } from "../lib/session.ts";
import type { FeedbackInput } from "../schemas/feedback.schema.ts";

/**
 * Feedback: one ask per visit, one form, and a reply that scales with the rating.
 *
 * Nothing here pages anyone yet. A low rating is stored with `escalate` so a
 * notifier can pick it up later; until one exists, the guest is told only what
 * is true -- that it has been passed on.
 */

export type Ratings = Pick<FeedbackInput, "overall" | "food" | "service" | "ambience" | "cleanliness">;
export type Tier = "five" | "four" | "three" | "low";

export type Guest = { userId: string; name: string | null; lastVisitAt: Date | null } | null;

const REVIEW_ASK_EVERY_MS = 30 * 24 * 60 * 60_000;

/**
 * The response ladder. Any category at 2 or below is treated at its own
 * severity, whatever the overall says: a 5 overall with a 1 for cleanliness is
 * a complaint about cleanliness, not a happy guest.
 */
export function feedbackTier(r: Ratings): { tier: Tier; escalate: boolean } {
  const worst = Math.min(r.overall, r.food, r.service, r.ambience, r.cleanliness);
  if (worst <= 2) return { tier: "low", escalate: true };
  if (r.overall >= 5) return { tier: "five", escalate: false };
  if (r.overall === 4) return { tier: "four", escalate: false };
  return { tier: "three", escalate: false };
}

/** Says the guest's name the first time only. */
export function takeName(session: Session, guest: Guest): string | null {
  if (!guest?.name || session.nameUsed) return null;
  session.nameUsed = true;
  return guest.name;
}

export type FeedbackStore = {
  saveFeedback(row: {
    sessionId: string;
    userId: string | null;
    ratings: Ratings;
    comment: string | null;
    quick: boolean;
    escalate: boolean;
  }): Promise<void>;
  /** True when the Google link may be offered, and records that it was. */
  claimReviewAsk(userId: string | null): Promise<boolean>;
};

export const prismaFeedbackStore: FeedbackStore = {
  async saveFeedback(row) {
    const { prisma } = await import("../../db/index.ts");
    await prisma.feedback.create({
      data: {
        sessionId: row.sessionId,
        userId: row.userId,
        ...row.ratings,
        comment: row.comment,
        quick: row.quick,
        escalate: row.escalate,
      },
    });
  },

  async claimReviewAsk(userId) {
    // An anonymous guest can only be asked once per session, which the
    // one-submission rule already guarantees.
    if (!userId) return true;
    const { prisma } = await import("../../db/index.ts");
    const cutoff = new Date(Date.now() - REVIEW_ASK_EVERY_MS);
    const claimed = await prisma.user.updateMany({
      where: { id: userId, OR: [{ lastReviewAskAt: null }, { lastReviewAskAt: { lt: cutoff } }] },
      data: { lastReviewAskAt: new Date() },
    });
    return claimed.count > 0;
  },
};

export type FeedbackReply = { answer: string; chips: string[]; tier: Tier; escalate: boolean };

export async function submitFeedback(
  session: Session,
  guest: Guest,
  input: FeedbackInput,
  opts: { quick?: boolean; store?: FeedbackStore } = {},
): Promise<FeedbackReply> {
  const store = opts.store ?? prismaFeedbackStore;
  if (session.feedbackSubmitted) throw conflict(copy.FEEDBACK_ALREADY, "FEEDBACK_ALREADY_SUBMITTED");

  const { overall, food, service, ambience, cleanliness } = input;
  const ratings = { overall, food, service, ambience, cleanliness };
  const { tier, escalate } = feedbackTier(ratings);

  await store.saveFeedback({
    sessionId: session.id,
    userId: guest?.userId ?? null,
    ratings,
    comment: input.comment ?? null,
    quick: opts.quick ?? false,
    escalate,
  });
  session.feedbackSubmitted = true;

  if (tier === "low") {
    // The yes/no comes back as a chat message; concierge.service.ts handles it.
    session.pendingManagerOffer = true;
    return { answer: copy.FEEDBACK_REPLY.low, chips: [...copy.MANAGER_OFFER_BUTTONS], tier, escalate };
  }

  const lines: string[] = [copy.FEEDBACK_REPLY[tier]];
  if (tier === "five" && env.GOOGLE_REVIEW_URL && (await store.claimReviewAsk(guest?.userId ?? null))) {
    lines.push(copy.FEEDBACK_REPLY.reviewLink(env.GOOGLE_REVIEW_URL));
  }
  // Feedback is where the evening ends. Say goodbye once, then stop.
  session.delights = { ...session.delights, farewell: true };
  lines.push(copy.CLOSING(takeName(session, guest)));

  return { answer: lines.join("\n\n"), chips: [], tier, escalate };
}

/** What GET /api/feedback/ask returns. `shouldAsk` is false once declined or answered. */
export function feedbackAsk(session: Session, guest: Guest) {
  if (session.feedbackSubmitted || session.feedbackDeclined) {
    return { shouldAsk: false, answer: null, buttons: [] as string[] };
  }
  return {
    shouldAsk: true,
    answer: copy.FEEDBACK_ASK(takeName(session, guest)),
    buttons: [...copy.FEEDBACK_BUTTONS],
  };
}
