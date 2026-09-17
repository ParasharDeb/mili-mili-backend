import { Router } from "express";
import * as controller from "../controllers/menu.controller.ts";
import { validateBody } from "../middleware/validate.ts";
import { recommendSchema } from "../schemas/menu.schema.ts";

export const menuRouter = Router();

// POST, not GET: the guest's free text can run to 400 characters and does not
// belong in a URL or in access logs.
menuRouter.post("/recommend", validateBody(recommendSchema), controller.recommend);
