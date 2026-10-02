import { Router } from "express";
import * as controller from "../controllers/order.controller.ts";
import { optionalAuth } from "../middleware/auth.ts";
import { withSession } from "../middleware/session.ts";
import { validateBody, validateParams } from "../middleware/validate.ts";
import { orderDecisionSchema, orderIdParamSchema, placeOrderSchema } from "../schemas/order.schema.ts";

/**
 * Orders sent from the cart for a captain to confirm.
 *
 * Guest routes share the cart's session: possession of the session id is the
 * claim, and it only ever reaches that session's own orders. The decision
 * callback is KCPL's, guarded by a shared secret rather than a session.
 */
export const orderRouter = Router();

orderRouter.post("/:id/decision", validateParams(orderIdParamSchema), validateBody(orderDecisionSchema), controller.kcplDecision);

orderRouter.use(withSession, optionalAuth);
orderRouter.get("/", controller.list);
orderRouter.post("/", validateBody(placeOrderSchema), controller.place);
orderRouter.get("/:id", validateParams(orderIdParamSchema), controller.get);
orderRouter.post("/:id/cancel", validateParams(orderIdParamSchema), controller.cancel);
