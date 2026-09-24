import type { Request, Response } from "express";
import * as service from "../services/menu.cart.service.ts";
import type { AddManyToCartInput, AddToCartInput, SetQuantityInput } from "../schemas/cart.schema.ts";

export async function view(req: Request, res: Response) {
  res.json(await service.view(req.session));
}

export async function add(req: Request, res: Response) {
  const { itemId, qty } = req.body as AddToCartInput;
  const item = await service.add(req.session, itemId, qty);
  res.status(201).json({ added: item, ...(await service.view(req.session)) });
}

export async function addMany(req: Request, res: Response) {
  const { lines } = req.body as AddManyToCartInput;
  const added = await service.addMany(req.session, lines);
  res.status(201).json({ added, ...(await service.view(req.session)) });
}

export async function setQuantity(req: Request, res: Response) {
  const { itemId } = req.params as { itemId: string };
  const { qty } = req.body as SetQuantityInput;
  service.setQuantity(req.session, itemId, qty);
  res.json(await service.view(req.session));
}

export async function remove(req: Request, res: Response) {
  const { itemId } = req.params as { itemId: string };
  service.remove(req.session, itemId);
  res.json(await service.view(req.session));
}

export async function clear(req: Request, res: Response) {
  service.clear(req.session);
  res.json(await service.view(req.session));
}
