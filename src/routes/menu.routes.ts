import { Router } from "express";
import * as categoryController from "../controllers/category.controller.ts";
import * as menuController from "../controllers/menu.controller.ts";
import { validateParams, validateQuery } from "../middleware/validate.ts";
import {
  idParamSchema,
  listCategoriesQuerySchema,
  listMenuItemsQuerySchema,
} from "../schemas/menu.schema.ts";

/** Public, read-only. No auth required — this is what the user app browses. */
export const menuRouter = Router();

menuRouter.get("/categories", validateQuery(listCategoriesQuerySchema), categoryController.list);
menuRouter.get("/categories/:id", validateParams(idParamSchema), categoryController.get);

menuRouter.get("/items", validateQuery(listMenuItemsQuerySchema), menuController.list);
menuRouter.get("/items/:id", validateParams(idParamSchema), menuController.get);
