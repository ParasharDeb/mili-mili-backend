import { Router } from "express";
import { requireAdmin } from "../middleware/auth.ts";
import { listReviews } from "../services/admin.reviews.service.ts";
import * as orders from "../controllers/order.controller.ts";
import { validateBody, validateParams } from "../middleware/validate.ts";
import { orderDecisionSchema, orderIdParamSchema } from "../schemas/order.schema.ts";

export const adminRouter = Router();

// Everything under here reads guest words. Never mount it without the guard.
adminRouter.use(...requireAdmin);

adminRouter.get("/reviews", async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
  res.json(await listReviews({ limit }));
});

// Orders waiting on a captain. Accepting here is the fallback when KCPL is not
// wired up or is down -- it moves the order exactly as KCPL's callback would.
adminRouter.get("/orders", orders.staffList);
adminRouter.post(
  "/orders/:id/decision",
  validateParams(orderIdParamSchema),
  validateBody(orderDecisionSchema),
  orders.staffDecision,
);
