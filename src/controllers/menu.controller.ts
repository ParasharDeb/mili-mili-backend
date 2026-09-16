import type { Request, Response } from "express";
import * as menu from "../services/menu.service.ts";
import type { CreateMenuItemInput, UpdateMenuItemInput } from "../schemas/menu.schema.ts";

export async function list(req: Request, res: Response) {
  const { categoryId, includeUnavailable } = (req.validatedQuery ?? {}) as {
    categoryId?: string;
    includeUnavailable?: boolean;
  };
  const asAdmin = req.auth?.role === "admin";

  res.json(
    await menu.listMenuItems({ categoryId, includeUnavailable: asAdmin && includeUnavailable }),
  );
}

export async function get(req: Request, res: Response) {
  res.json(await menu.getMenuItem(req.params["id"] as string));
}

export async function create(req: Request, res: Response) {
  res.status(201).json(await menu.createMenuItem(req.body as CreateMenuItemInput));
}

export async function update(req: Request, res: Response) {
  const result = await menu.updateMenuItem(
    req.params["id"] as string,
    req.body as UpdateMenuItemInput,
  );
  res.json(result);
}

export async function remove(req: Request, res: Response) {
  await menu.deleteMenuItem(req.params["id"] as string);
  res.status(204).end();
}
