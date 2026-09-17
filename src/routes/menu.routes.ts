import { Router } from "express";
import * as controller from "../controllers/menu.controller.ts";
import { validateBody, validateParams, validateQuery } from "../middleware/validate.ts";
import {
  chatSchema,
  idParamSchema,
  listItemsSchema,
  pairingsQuerySchema,
  recommendSchema,
} from "../schemas/menu.schema.ts";

export const menuRouter = Router();

/** The menu itself, straight from Postgres. Powers /menu and the staff dashboard. */
menuRouter.get("/items", validateQuery(listItemsSchema), controller.list);
menuRouter.get("/stats", controller.stats);

/** Dish -> drink, or drink -> dish. Direction is inferred from the item's own course. */
menuRouter.get(
  "/items/:id/pairings",
  validateParams(idParamSchema),
  validateQuery(pairingsQuerySchema),
  controller.pairings,
);

// POST, not GET: the guest's free text can run to 400 characters and does not
// belong in a URL or in access logs.

/** One door for the chat UI -- the backend decides question vs. recommendation. */
menuRouter.post("/chat", validateBody(chatSchema), controller.chat);

/** Recommendations only, for callers that already know that's what they want. */
menuRouter.post("/recommend", validateBody(recommendSchema), controller.recommend);
