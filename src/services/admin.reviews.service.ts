import { prisma } from "../../db/index.ts";

/**
 * Every review in one list for the staff dashboard: what guests said in passing
 * in the chat, and the rated form at the end of the evening.
 *
 * Both are guest words, so this is admin-only. See routes/admin.routes.ts.
 */

export type ReviewEntry = {
  id: string;
  source: "chat" | "form";
  createdAt: Date;
  sentiment: "positive" | "negative" | "mixed";
  message: string | null;
  dish: string | null;
  /** Form only: the five star ratings. */
  ratings: { overall: number; food: number; service: number; ambience: number; cleanliness: number } | null;
  /** Form only: a one-tap "Everything was lovely" rather than a filled-in form. */
  quick: boolean;
  /** Form only: overall or any category at 2 or below. */
  escalate: boolean;
};

/** A form has no words to read a mood from, so its stars stand in. */
function formSentiment(overall: number, escalate: boolean): ReviewEntry["sentiment"] {
  if (escalate || overall <= 2) return "negative";
  if (overall === 3) return "mixed";
  return "positive";
}

export async function listReviews(opts: { limit: number }) {
  const [chat, forms] = await Promise.all([
    prisma.review.findMany({ orderBy: { createdAt: "desc" }, take: opts.limit }),
    prisma.feedback.findMany({ orderBy: { createdAt: "desc" }, take: opts.limit }),
  ]);

  const entries: ReviewEntry[] = [
    ...chat.map((r) => ({
      id: r.id,
      source: "chat" as const,
      createdAt: r.createdAt,
      sentiment: r.sentiment,
      message: r.message,
      dish: r.itemName,
      ratings: null,
      quick: false,
      escalate: r.sentiment === "negative",
    })),
    ...forms.map((f) => ({
      id: f.id,
      source: "form" as const,
      createdAt: f.createdAt,
      sentiment: formSentiment(f.overall, f.escalate),
      message: f.comment,
      dish: null,
      ratings: { overall: f.overall, food: f.food, service: f.service, ambience: f.ambience, cleanliness: f.cleanliness },
      quick: f.quick,
      escalate: f.escalate,
    })),
  ]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, opts.limit);

  const counts = { total: entries.length, positive: 0, negative: 0, mixed: 0 };
  for (const e of entries) counts[e.sentiment]++;

  return { counts, reviews: entries };
}
