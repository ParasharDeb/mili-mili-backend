import type { Request, Response } from "express";
import type {
  ChatInput,
  ListItemsInput,
  PairingsQueryInput,
  RecommendInput,
} from "../schemas/menu.schema.ts";
import * as chatService from "../services/menu.chat.service.ts";
import * as items from "../services/menu.items.service.ts";
import * as pairingService from "../services/menu.pairing.service.ts";
import * as reco from "../services/menu.recommend.service.ts";
import { heuristicPlan, planSlots } from "../services/menu.slots.service.ts";
import { isJevAvailable } from "../lib/jev.ts";

export async function recommend(req: Request, res: Response) {
  const input = req.body as RecommendInput;
  // This route skips the router: the caller has already decided it wants
  // recommendations, so only the slot parse is needed.
  const parsed = isJevAvailable()
    ? await planSlots(input.query)
    : { plan: heuristicPlan(input.query), mode: "heuristic" as const };
  res.json(await reco.recommend(input, parsed));
}

export async function chat(req: Request, res: Response) {
  const result = await chatService.chat(req.body as ChatInput, req.session);
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

/** What goes well with this dish, or -- for a drink -- what goes well with it. */
export async function pairings(req: Request, res: Response) {
  const { id } = req.params as { id: string };
  const { limit } = req.validatedQuery as PairingsQueryInput;
  res.json(await pairingService.pairings(id, limit));
}
