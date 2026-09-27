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

/**
 * Like `requireAuth`, but a missing or bad token is simply no identity. For guest
 * routes where signing in adds a name and history but is never required.
 */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      const payload = await verifyToken(header.slice("Bearer ".length).trim());
      req.auth = { id: payload.sub, role: payload.role };
    } catch {
      // An expired token must not stop a guest from asking for the manager.
    }
  }
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
