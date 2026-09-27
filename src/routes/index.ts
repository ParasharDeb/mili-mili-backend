import { Router } from "express";
import { adminAuthRouter } from "./admin.auth.routes.ts";
import { userAuthRouter } from "./user.auth.routes.ts";
import { cartRouter } from "./cart.routes.ts";
import { menuRouter } from "./menu.routes.ts";
import { feedbackRouter } from "./feedback.routes.ts";
import { optionalAuth, requireAuth } from "../middleware/auth.ts";
import { withSession } from "../middleware/session.ts";
import { me, updatePreferences } from "../controllers/me.controller.ts";
import { validateBody } from "../middleware/validate.ts";
import { preferencesSchema } from "../schemas/feedback.schema.ts";

export const apiRouter = Router();

apiRouter.get("/health", (_req, res) => res.json({ status: "ok" }));

apiRouter.use("/auth/admin", adminAuthRouter);
apiRouter.use("/auth/user", userAuthRouter);
apiRouter.get("/auth/me", requireAuth, me);
apiRouter.patch("/auth/me/preferences", requireAuth, validateBody(preferencesSchema), updatePreferences);

// Signing in is optional for guests: it adds a name and "it's been a while".
apiRouter.use("/menu", withSession, optionalAuth, menuRouter);

// One ask, one form, per visit. Shares the chat's session.
apiRouter.use("/feedback", withSession, optionalAuth, feedbackRouter);

// The order a guest is building, kept in memory for the length of their visit.
apiRouter.use("/cart", withSession, cartRouter);
