import { Router } from "express";
import { adminAuthRouter } from "./admin.auth.routes.ts";
import { userAuthRouter } from "./user.auth.routes.ts";
import { cartRouter } from "./cart.routes.ts";
import { menuRouter } from "./menu.routes.ts";
import { requireAuth } from "../middleware/auth.ts";
import { withSession } from "../middleware/session.ts";
import { me } from "../controllers/me.controller.ts";

export const apiRouter = Router();

apiRouter.get("/health", (_req, res) => res.json({ status: "ok" }));

apiRouter.use("/auth/admin", adminAuthRouter);
apiRouter.use("/auth/user", userAuthRouter);
apiRouter.get("/auth/me", requireAuth, me);

apiRouter.use("/menu", withSession, menuRouter);

// The order a guest is building, kept in memory for the length of their visit.
apiRouter.use("/cart", withSession, cartRouter);
