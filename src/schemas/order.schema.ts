import { z } from "zod";

/** "12", "T12", "B-3", "Terrace 4" -- whatever is printed on the table. */
const tableNumber = z
  .string()
  .trim()
  .min(1)
  .max(16)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 \-]*$/, "That doesn't look like a table number");

/** Indian mobile, with or without +91 / 0, spaces and dashes ignored. */
const phone = z
  .string()
  .transform((s) => s.replace(/[\s\-()]/g, "").replace(/^(\+91|0091|0)/, ""))
  .pipe(z.string().regex(/^[6-9]\d{9}$/, "Enter a 10-digit mobile number"));

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

export const placeOrderSchema = z
  .object({
    tableNumber: z.preprocess(blankToUndefined, tableNumber.optional()),
    phone: z.preprocess(blankToUndefined, phone.optional()),
    guestName: z.preprocess(blankToUndefined, z.string().trim().max(60).optional()),
    note: z.preprocess(blankToUndefined, z.string().trim().max(300).optional()),
  })
  .refine((v) => v.tableNumber || v.phone, {
    message: "Scan your table's QR code, or tell us your table number or phone number.",
    path: ["tableNumber"],
  });

export const orderIdParamSchema = z.object({
  id: z.string().uuid("Invalid order id"),
});

/** From KCPL (shared secret) or the staff dashboard (admin token). */
export const orderDecisionSchema = z.object({
  status: z.enum(["accepted", "rejected"]),
  reason: z.string().trim().max(200).optional(),
  /** KCPL only: the captain who took it, for the record. */
  captain: z.string().trim().max(60).optional(),
  kcplRef: z.string().trim().max(100).optional(),
});

export type PlaceOrderInput = z.infer<typeof placeOrderSchema>;
export type OrderDecisionInput = z.infer<typeof orderDecisionSchema>;
