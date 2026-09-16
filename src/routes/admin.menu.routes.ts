import { Router } from "express";
import * as categoryController from "../controllers/category.controller.ts";
import * as menuController from "../controllers/menu.controller.ts";
import { requireAdmin } from "../middleware/auth.ts";
import { validateBody, validateParams } from "../middleware/validate.ts";
import {
  createCategorySchema,
  createMenuItemSchema,
  idParamSchema,
  updateCategorySchema,
  updateMenuItemSchema,
} from "../schemas/menu.schema.ts";

/** Admin dashboard writes. Every route below requires a valid admin JWT. */
export const adminMenuRouter = Router();

adminMenuRouter.use(...requireAdmin);

adminMenuRouter.post("/categories", validateBody(createCategorySchema), categoryController.create);
adminMenuRouter.patch(
  "/categories/:id",
  validateParams(idParamSchema),
  validateBody(updateCategorySchema),
  categoryController.update,
);
adminMenuRouter.delete("/categories/:id", validateParams(idParamSchema), categoryController.remove);

adminMenuRouter.post("/items", validateBody(createMenuItemSchema), menuController.create);
// The core admin edit: name, price, imageUrl, description.
adminMenuRouter.patch(
  "/items/:id",
  validateParams(idParamSchema),
  validateBody(updateMenuItemSchema),
  menuController.update,
);
adminMenuRouter.delete("/items/:id", validateParams(idParamSchema), menuController.remove);
