import { Router } from "express";
import { requireAdmin } from "../middleware/auth.ts";
import { listReviews } from "../services/admin.reviews.service.ts";

export const adminRouter = Router();

// Everything under here reads guest words. Never mount it without the guard.
adminRouter.use(...requireAdmin);

adminRouter.get("/reviews", async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
  res.json(await listReviews({ limit }));
});
