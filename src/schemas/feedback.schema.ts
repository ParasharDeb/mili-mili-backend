import { z } from "zod";

const stars = z.coerce.number().int().min(1).max(5);

/** POST /api/feedback -- the one-screen form. Six fields, no more. */
export const feedbackSchema = z.object({
  overall: stars,
  food: stars,
  service: stars,
  ambience: stars,
  cleanliness: stars,
  comment: z.string().trim().max(1000).optional().transform((c) => c || undefined),
});

export type FeedbackInput = z.infer<typeof feedbackSchema>;

/** PATCH /api/auth/me/preferences */
export const preferencesSchema = z.object({
  marketingOptIn: z.boolean(),
});

export type PreferencesInput = z.infer<typeof preferencesSchema>;
