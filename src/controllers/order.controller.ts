import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { env } from "../lib/env.ts";
import { AppError, unauthorized } from "../lib/errors.ts";
import type { OrderDecisionInput, PlaceOrderInput } from "../schemas/order.schema.ts";
import { loadGuest } from "../services/concierge.service.ts";
import * as orders from "../services/order.service.ts";

export async function place(req: Request, res: Response) {
  const guest = await loadGuest(req.auth);
  const order = await orders.place(req.session, req.body as PlaceOrderInput, guest);
  res.status(201).json({ order });
}

export async function list(req: Request, res: Response) {
  res.json({ orders: await orders.listForSession(req.session) });
}

/** Polled by the guest's "a captain is on the way" screen. */
export async function get(req: Request, res: Response) {
  const { id } = req.params as { id: string };
  res.json({ order: await orders.get(req.session, id) });
}

export async function cancel(req: Request, res: Response) {
  const { id } = req.params as { id: string };
  res.json({ order: await orders.cancel(req.session, id) });
}

function secretMatches(given: string | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(env.KCPL_SHARED_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** KCPL's callback once a captain has accepted or rejected the order at the table. */
export async function kcplDecision(req: Request, res: Response) {
  if (!env.KCPL_SHARED_SECRET) {
    throw new AppError(503, "KCPL callbacks are not configured.", "KCPL_NOT_CONFIGURED");
  }
  if (!secretMatches(req.get("x-kcpl-secret"))) throw unauthorized("Bad KCPL secret", "BAD_KCPL_SECRET");

  const { id } = req.params as { id: string };
  const { status, reason, captain, kcplRef } = req.body as OrderDecisionInput;
  const order = await orders.decide(id, { status, reason, kcplRef }, `kcpl:${captain ?? "captain"}`);
  res.json({ order: orders.toPublicOrder(order) });
}

/** The staff dashboard's accept / reject, for when KCPL is not wired up or is down. */
export async function staffDecision(req: Request, res: Response) {
  const { id } = req.params as { id: string };
  const { status, reason } = req.body as OrderDecisionInput;
  const order = await orders.decide(id, { status, reason }, `staff:${req.auth?.id ?? "unknown"}`);
  res.json({ order: orders.toStaffOrder(order) });
}

export async function staffList(req: Request, res: Response) {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 300);
  res.json(await orders.listForStaff({ limit }));
}
