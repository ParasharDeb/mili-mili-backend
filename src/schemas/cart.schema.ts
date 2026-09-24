import { z } from "zod";

export const addToCartSchema = z.object({
  itemId: z.string().uuid("Invalid item id"),
  qty: z.coerce.number().int().min(1).max(20).default(1),
});

/** A whole combo at once. qty 0 means the guest dropped that item. */
export const addManyToCartSchema = z.object({
  lines: z
    .array(z.object({
      itemId: z.string().uuid("Invalid item id"),
      qty: z.coerce.number().int().min(0).max(20),
    }))
    .min(1)
    .max(10),
});

export const setQuantitySchema = z.object({
  /** Zero removes the line, which is what a stepper clicked down to 0 means. */
  qty: z.coerce.number().int().min(0).max(20),
});

export const cartItemParamSchema = z.object({
  itemId: z.string().uuid("Invalid item id"),
});

export type AddToCartInput = z.infer<typeof addToCartSchema>;
export type AddManyToCartInput = z.infer<typeof addManyToCartSchema>;
export type SetQuantityInput = z.infer<typeof setQuantitySchema>;
