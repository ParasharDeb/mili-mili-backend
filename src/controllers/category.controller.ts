import type { Request, Response } from "express";
import * as categories from "../services/category.service.ts";
import type { CreateCategoryInput, UpdateCategoryInput } from "../schemas/menu.schema.ts";

export async function list(req: Request, res: Response) {
  const { includeInactive } = (req.validatedQuery ?? {}) as { includeInactive?: boolean };
  // Only an authenticated admin may see inactive categories.
  const asAdmin = req.auth?.role === "admin";

  res.json(await categories.listCategories({ includeInactive: asAdmin && includeInactive }));
}

export async function get(req: Request, res: Response) {
  res.json(await categories.getCategory(req.params["id"] as string));
}

export async function create(req: Request, res: Response) {
  res.status(201).json(await categories.createCategory(req.body as CreateCategoryInput));
}

export async function update(req: Request, res: Response) {
  const result = await categories.updateCategory(
    req.params["id"] as string,
    req.body as UpdateCategoryInput,
  );
  res.json(result);
}

export async function remove(req: Request, res: Response) {
  await categories.deleteCategory(req.params["id"] as string);
  res.status(204).end();
}
