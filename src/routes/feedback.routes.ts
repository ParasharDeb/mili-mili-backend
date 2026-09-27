import { Router } from "express";
import * as controller from "../controllers/feedback.controller.ts";
import { validateBody } from "../middleware/validate.ts";
import { feedbackSchema } from "../schemas/feedback.schema.ts";

export const feedbackRouter = Router();

/** The ask and its three buttons. The frontend decides when to show it. */
feedbackRouter.get("/ask", controller.ask);
feedbackRouter.post("/", validateBody(feedbackSchema), controller.submit);
