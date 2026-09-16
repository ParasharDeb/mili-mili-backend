import { Router } from "express";
import * as controller from "../controllers/admin.auth.controller.ts";
import { validateBody } from "../middleware/validate.ts";
import { requireAdmin } from "../middleware/auth.ts";
import { adminLoginSchema, adminRegisterSchema } from "../schemas/auth.schema.ts";

export const adminAuthRouter = Router();

// Creating admins is itself an admin action. Bootstrap the first one with
// `bun run db:seed`.
adminAuthRouter.post(
  "/register",
  ...requireAdmin,
  validateBody(adminRegisterSchema),
  controller.register,
);

adminAuthRouter.post("/login", validateBody(adminLoginSchema), controller.login);
