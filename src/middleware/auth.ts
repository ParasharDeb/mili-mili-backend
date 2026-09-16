import type { NextFunction, Request, Response } from "express";
import { verifyToken, type Role } from "../lib/jwt.ts";
import { forbidden, unauthorized } from "../lib/errors.ts";

/** Verifies the `Authorization: Bearer <token>` header and populates `req.auth`. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;

  if (!header?.startsWith("Bearer ")) {
    return next(unauthorized("Missing bearer token", "MISSING_TOKEN"));
  }

  const payload = await verifyToken(header.slice("Bearer ".length).trim());
  req.auth = { id: payload.sub, role: payload.role };
  next();
}

/** Must run after `requireAuth`. */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(unauthorized());
    if (!roles.includes(req.auth.role)) {
      return next(forbidden(`Requires role: ${roles.join(" or ")}`));
    }
    next();
  };
}

export const requireAdmin = [requireAuth, requireRole("admin")];
