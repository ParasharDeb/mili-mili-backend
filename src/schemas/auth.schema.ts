import { z } from "zod";
import { DietPrefEnum } from "../../generated/prisma/enums.ts";

/** E.164: a leading +, country code starting 1-9, then up to 14 more digits. */
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, "Phone must be in E.164 format, e.g. +919876543210");

export const emailSchema = z.string().trim().toLowerCase().email("Invalid email address");

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password must be at most 128 characters");

export const adminLoginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required"),
});

export const adminRegisterSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(100).optional(),
});

export const requestOtpSchema = z.object({
  phone: phoneSchema,
});

export const dietPreferenceSchema = z.enum(DietPrefEnum, {
  error: `Diet preference must be one of: ${Object.values(DietPrefEnum).join(", ")}`,
});

export const verifyOtpSchema = z.object({
  phone: phoneSchema,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "OTP must be 6 digits"),
  name: z.string().trim().min(1).max(100).optional(),
  /**
   * Required on the first verify (signup) only; the service rejects a new user
   * without one. Ignored on subsequent logins, where the stored value wins.
   */
  dietPreference: dietPreferenceSchema.optional(),
});

export type AdminLoginInput = z.infer<typeof adminLoginSchema>;
export type AdminRegisterInput = z.infer<typeof adminRegisterSchema>;
export type RequestOtpInput = z.infer<typeof requestOtpSchema>;
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;
