import type { Request, Response } from "express";
import type {
  ChatInput,
  ListItemsInput,
  RecommendInput,
} from "../schemas/menu.schema.ts";
import * as chatService from "../services/menu.chat.service.ts";
import * as items from "../services/menu.items.service.ts";
import * as reco from "../services/menu.recommend.service.ts";

export async function recommend(req: Request, res: Response) {
  const result = await reco.recommend(req.body as RecommendInput);
  res.json(result);
}

export async function chat(req: Request, res: Response) {
  const result = await chatService.chat(req.body as ChatInput);
  res.json(result);
}

export async function list(req: Request, res: Response) {
  // Express 5 makes req.query read-only, so validateQuery lands here instead.
  const result = await items.listItems(req.validatedQuery as ListItemsInput);
  res.json(result);
}

export async function stats(_req: Request, res: Response) {
  res.json(await items.itemStats());
}
