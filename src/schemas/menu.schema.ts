import { z } from "zod";

/**
 * The LLM is never asked to spell the Prisma diet enum. `DietPrefEnum` is
 * misspelled in schema.prisma (`Vegeterian`, `Non_vegeterian`), and a model told
 * to emit those tokens "corrects" them a fair share of the time. It answers in
 * diner language and menu.filter.ts maps to the DB spelling.
 */
export const dietSlotSchema = z.enum(["veg", "nonveg", "egg", "fish", "jain", "any"]);
export const spiceSlotSchema = z.enum(["none", "mild", "medium", "spicy", "very_spicy", "any"]);
export const cuisineSlotSchema = z.enum([
  "Indian", "Asian", "Italian", "Continental", "Beverage", "Other", "any",
]);
export const courseSlotSchema = z.enum([
  "Starter", "MainCourse", "Bread", "Salad", "Dessert",
  "Beverage", "Alcohol", "Shisha", "Sides", "any",
]);
/** Coarse food/drink intent, used when no specific course was stated. */
export const courseGroupSchema = z.enum(["food", "drink", "any"]);

export const slotSchema = z.object({
  label: z.string().trim().min(1).max(60),
  count: z.number().int().min(1).max(50),
  diet: dietSlotSchema,
  spice: spiceSlotSchema,
  cuisine: cuisineSlotSchema,
  course: courseSlotSchema,
  courseGroup: courseGroupSchema,
  searchText: z.string().trim().min(1).max(160),
});

export const slotPlanSchema = z.object({
  partySize: z.number().int().min(0).max(100),
  // May legitimately be empty: "what's good here?" states no constraint.
  slots: z.array(slotSchema),
});

export const recommendSchema = z.object({
  query: z.string().trim().min(3, "Tell us who's eating").max(400),
  perSlot: z.coerce.number().int().min(1).max(5).default(3),
  /** Forces every slot to consider drinks and shisha as well as food. */
  includeDrinks: z.boolean().default(false),
});

export type Slot = z.infer<typeof slotSchema>;
export type SlotPlan = z.infer<typeof slotPlanSchema>;
export type RecommendInput = z.infer<typeof recommendSchema>;

/** GET /api/menu/items */
export const listItemsSchema = z.object({
  group: z.enum(["food", "drink", "all"]).default("food"),
  course: z.enum([
    "Starter", "MainCourse", "Bread", "Salad", "Dessert",
    "Beverage", "Alcohol", "Shisha", "Sides",
  ]).optional(),
  diet: z.enum(["veg", "nonveg", "any"]).default("any"),
  q: z.string().trim().min(1).max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(500),
});

/**
 * POST /api/menu/chat -- one door for the chat UI. The backend decides whether a
 * message is a party request or a question, so the frontend does not have to.
 */
export const chatSchema = z.object({
  message: z.string().trim().min(1, "Say something").max(400),
  perSlot: z.coerce.number().int().min(1).max(5).default(3),
  includeDrinks: z.boolean().default(false),
});

export type ListItemsInput = z.infer<typeof listItemsSchema>;
export type ChatInput = z.infer<typeof chatSchema>;

/** GET /api/menu/items/:id/pairings */
export const idParamSchema = z.object({
  id: z.string().uuid("Invalid id"),
});

export const pairingsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(10).default(3),
});

export type IdParam = z.infer<typeof idParamSchema>;
export type PairingsQueryInput = z.infer<typeof pairingsQuerySchema>;
