import { z } from "zod";

/**
 * Money never goes through a float. Numbers are stringified immediately and
 * validated by regex, then handed to Prisma as a string for its Decimal column.
 * (`249.99 * 100 === 24998.999...`, so any cents-based rounding check is a trap.)
 */
export const priceSchema = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === "number" ? v.toString() : v.trim()))
  .refine(
    (v) => /^\d{1,8}(\.\d{1,2})?$/.test(v),
    "Price must be a non-negative amount with at most 2 decimal places, e.g. 249.99",
  );

export const imageUrlSchema = z.string().trim().url("Image must be a valid URL").max(2048);

export const idParamSchema = z.object({
  id: z.string().uuid("Invalid id"),
});

/* ---------- categories ---------- */

export const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  imageUrl: imageUrlSchema.optional(),
  sortOrder: z.coerce.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

export const updateCategorySchema = createCategorySchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to update");

export const listCategoriesQuerySchema = z.object({
  /** Admins can pass ?includeInactive=true; the public list hides inactive rows. */
  includeInactive: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

/* ---------- menu items ---------- */

export const createMenuItemSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  price: priceSchema,
  imageUrl: imageUrlSchema.optional(),
  isAvailable: z.boolean().optional(),
  categoryId: z.string().uuid("Invalid categoryId"),
});

/** The admin edit payload: name, price, image, description (all optional). */
export const updateMenuItemSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    price: priceSchema.optional(),
    imageUrl: imageUrlSchema.nullable().optional(),
    isAvailable: z.boolean().optional(),
    categoryId: z.string().uuid("Invalid categoryId").optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to update");

export const listMenuItemsQuerySchema = z.object({
  categoryId: z.string().uuid("Invalid categoryId").optional(),
  includeUnavailable: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type CreateMenuItemInput = z.infer<typeof createMenuItemSchema>;
export type UpdateMenuItemInput = z.infer<typeof updateMenuItemSchema>;
