import type { Role } from "../lib/jwt.ts";
import type { Session } from "../lib/session.ts";

declare global {
  namespace Express {
    interface Request {
      /** Set by `requireAuth`; absent on unauthenticated routes. */
      auth?: { id: string; role: Role };
      /** Set by `validateQuery`; `req.query` itself is read-only in Express 5. */
      validatedQuery?: unknown;
      /**
       * Set by `withSession` on every /api/menu and /api/cart route. Always
       * present there, never elsewhere -- hence non-optional, since the routes
       * that do not mount the middleware do not read it either.
       */
      session: Session;
    }
  }
}

export {};
