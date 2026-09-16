import { SignJWT, jwtVerify } from "jose";
import { env } from "./env.ts";
import { AppError, unauthorized } from "./errors.ts";

const secret = new TextEncoder().encode(env.JWT_SECRET);
const ALG = "HS256";

export type Role = "admin" | "user";

export interface TokenPayload {
  sub: string;
  role: Role;
}

export async function signToken(payload: TokenPayload): Promise<string> {
  return new SignJWT({ role: payload.role })
    .setProtectedHeader({ alg: ALG })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(env.JWT_EXPIRES_IN)
    .sign(secret);
}

export async function verifyToken(token: string): Promise<TokenPayload> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: [ALG] });

    if (typeof payload.sub !== "string" || (payload.role !== "admin" && payload.role !== "user")) {
      throw unauthorized("Malformed token", "INVALID_TOKEN");
    }

    return { sub: payload.sub, role: payload.role };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw unauthorized("Invalid or expired token", "INVALID_TOKEN");
  }
}
