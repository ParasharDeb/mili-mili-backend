import { Router } from "express";
import * as controller from "../controllers/cart.controller.ts";
import { validateBody, validateParams } from "../middleware/validate.ts";
import {
  addManyToCartSchema,
  addToCartSchema,
  cartItemParamSchema,
  followUpSchema,
  setQuantitySchema,
} from "../schemas/cart.schema.ts";

/**
 * The cart is guest state, so none of this is authenticated -- possession of the
 * session id is the whole claim, and it grants a list of dish ids with no money
 * movement and no personal data behind it.
 */
export const cartRouter = Router();

cartRouter.get("/", controller.view);
cartRouter.post("/", validateBody(addToCartSchema), controller.add);
cartRouter.post("/batch", validateBody(addManyToCartSchema), controller.addMany);
// Asked by the chat only, after a button add -- the menu page never spends it.
cartRouter.post("/follow-up", validateBody(followUpSchema), controller.followUp);
cartRouter.patch("/:itemId", validateParams(cartItemParamSchema), validateBody(setQuantitySchema), controller.setQuantity);
cartRouter.delete("/:itemId", validateParams(cartItemParamSchema), controller.remove);
cartRouter.delete("/", controller.clear);
