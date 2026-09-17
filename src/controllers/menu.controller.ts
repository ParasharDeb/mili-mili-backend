import type { Request, Response } from "express";
import type { RecommendInput } from "../schemas/menu.schema.ts";
import * as menu from "../services/menu.recommend.service.ts";

export async function recommend(req: Request, res: Response) {
  const result = await menu.recommend(req.body as RecommendInput);
  res.json(result);
}
