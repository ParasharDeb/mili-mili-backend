import { Router } from "express";
import { adminAuthRouter } from "./admin.auth.routes.ts";
import { userAuthRouter } from "./user.auth.routes.ts";
import { menuRouter } from "./menu.routes.ts";
import { adminMenuRouter } from "./admin.menu.routes.ts";
import { requireAuth } from "../middleware/auth.ts";
import { me } from "../controllers/me.controller.ts";

export const apiRouter = Router();

apiRouter.get("/health", (_req, res) => res.json({ status: "ok" }));

apiRouter.use("/auth/admin", adminAuthRouter);
apiRouter.use("/auth/user", userAuthRouter);
apiRouter.get("/auth/me", requireAuth, me);

// Public menu browsing.
apiRouter.use("/menu", menuRouter);
// Admin dashboard writes (admin JWT enforced inside).
apiRouter.use("/admin/menu", adminMenuRouter);
