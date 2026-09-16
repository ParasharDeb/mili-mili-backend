import { prisma } from "../../db/index.ts";
import { env, isProduction } from "../lib/env.ts";
import { signToken } from "../lib/jwt.ts";
import { badRequest, tooManyRequests } from "../lib/errors.ts";
import { generateOtp, hashOtp, verifyOtpHash } from "./otp.service.ts";
import { sendSms } from "./sms.service.ts";
import type { RequestOtpInput, VerifyOtpInput } from "../schemas/auth.schema.ts";
import type { DietPrefEnum } from "../../generated/prisma/enums.ts";

const publicUser = (user: {
  id: string;
  phone: string;
  name: string | null;
  phoneVerifiedAt: Date | null;
  diet_preference: DietPrefEnum;
}) => ({
  id: user.id,
  phone: user.phone,
  name: user.name,
  phoneVerifiedAt: user.phoneVerifiedAt,
  dietPreference: user.diet_preference,
});

export async function requestOtp({ phone }: RequestOtpInput) {
  const lastCode = await prisma.otpCode.findFirst({
    where: { phone },
    orderBy: { createdAt: "desc" },
  });

  if (lastCode) {
    const elapsedSeconds = (Date.now() - lastCode.createdAt.getTime()) / 1000;
    const remaining = Math.ceil(env.OTP_RESEND_COOLDOWN_SECONDS - elapsedSeconds);

    if (remaining > 0) {
      throw tooManyRequests(`Please wait ${remaining}s before requesting another code`, "OTP_COOLDOWN");
    }
  }

  const code = generateOtp();
  const expiresAt = new Date(Date.now() + env.OTP_TTL_MINUTES * 60_000);

  await prisma.$transaction([
    // Only the newest code should be usable.
    prisma.otpCode.updateMany({
      where: { phone, consumedAt: null },
      data: { consumedAt: new Date() },
    }),
    prisma.otpCode.create({
      data: { phone, codeHash: await hashOtp(code), expiresAt },
    }),
  ]);

  await sendSms(phone, `Your verification code is ${code}. It expires in ${env.OTP_TTL_MINUTES} minutes.`);

  return {
    expiresAt,
    // Convenience for local testing only — never exposed in production.
    ...(isProduction ? {} : { devCode: code }),
  };
}

export async function verifyOtp({ phone, code, name, dietPreference }: VerifyOtpInput) {
  const record = await prisma.otpCode.findFirst({
    where: { phone, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (!record || record.expiresAt < new Date()) {
    throw badRequest("That code is invalid or has expired. Request a new one.", "OTP_INVALID");
  }

  if (record.attempts >= env.OTP_MAX_ATTEMPTS) {
    throw tooManyRequests("Too many incorrect attempts. Request a new code.", "OTP_ATTEMPTS_EXCEEDED");
  }

  if (!(await verifyOtpHash(code, record.codeHash))) {
    await prisma.otpCode.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
    });
    throw badRequest("That code is invalid or has expired. Request a new one.", "OTP_INVALID");
  }

  const existing = await prisma.user.findUnique({ where: { phone } });
  const isNewUser = existing === null;

  // Signup needs a diet preference; returning logins keep the stored one.
  if (isNewUser && !dietPreference) {
    throw badRequest(
      "dietPreference is required to complete signup",
      "DIET_PREFERENCE_REQUIRED",
    );
  }

  const user = await prisma.$transaction(async (tx) => {
    const saved = await tx.user.upsert({
      where: { phone },
      create: {
        phone,
        name: name ?? null,
        phoneVerifiedAt: new Date(),
        diet_preference: dietPreference!,
      },
      // Don't clobber an existing name/preference with an omitted one.
      update: {
        phoneVerifiedAt: new Date(),
        ...(name ? { name } : {}),
        ...(dietPreference ? { diet_preference: dietPreference } : {}),
      },
    });

    await tx.otpCode.update({
      where: { id: record.id },
      data: { consumedAt: new Date(), userId: saved.id },
    });

    return saved;
  });

  return {
    token: await signToken({ sub: user.id, role: "user" }),
    user: publicUser(user),
    isNewUser,
  };
}

export async function getUserById(id: string) {
  const user = await prisma.user.findUnique({ where: { id } });
  return user ? publicUser(user) : null;
}
