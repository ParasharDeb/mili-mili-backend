import type { Role } from "../lib/jwt.ts";

declare global {
  namespace Express {
    interface Request {
      /** Set by `requireAuth`; absent on unauthenticated routes. */
      auth?: { id: string; role: Role };
      /** Set by `validateQuery`; `req.query` itself is read-only in Express 5. */
      validatedQuery?: unknown;
    }
  }
}

export {};
