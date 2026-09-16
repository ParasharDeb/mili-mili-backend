import { randomInt } from "node:crypto";
import bcrypt from "bcrypt";

const OTP_LENGTH = 6;
const SALT_ROUNDS = 10;

/** Cryptographically random 6-digit code, zero-padded so every code is the same length. */
export function generateOtp(): string {
  return randomInt(0, 10 ** OTP_LENGTH)
    .toString()
    .padStart(OTP_LENGTH, "0");
}

export const hashOtp = (code: string): Promise<string> => bcrypt.hash(code, SALT_ROUNDS);

export const verifyOtpHash = (code: string, hash: string): Promise<boolean> =>
  bcrypt.compare(code, hash);
