import { randomInt } from "node:crypto";
import { prisma } from "../../db/index.ts";
import { Prisma, type Order } from "../../generated/prisma/client.ts";
import { env } from "../lib/env.ts";
import { AppError, conflict, notFound } from "../lib/errors.ts";
import type { Session } from "../lib/session.ts";
import type { OrderDecisionInput, PlaceOrderInput } from "../schemas/order.schema.ts";
import * as cart from "./menu.cart.service.ts";

/**
 * Orders: the cart, sent for a captain to confirm.
 *
 * Pressing "Order now" does not place an order. It sends one, as `pending`, to
 * KCPL -- the platform the captains work from -- and a captain comes to the
 * table to confirm it. Only once a captain accepts does the order count as
 * placed. Until then the guest is told, plainly, that someone is on their way.
 *
 * The cart is emptied the moment an order is sent, because the order now holds
 * those lines. A rejected order can be put back into the cart by the guest.
 */

export type OrderLine = {
  itemId: string;
  name: string;
  qty: number;
  unitPrice: number | null;
  lineTotal: number | null;
};

export type PublicOrder = {
  id: string;
  code: string;
  status: Order["status"];
  tableNumber: string | null;
  phone: string | null;
  note: string | null;
  lines: OrderLine[];
  itemCount: number;
  subtotal: number | null;
  rejectReason: string | null;
  /** False when KCPL could not be reached. Staff still see it on the dashboard. */
  sentToFloor: boolean;
  createdAt: Date;
  decidedAt: Date | null;
};

export type StaffOrder = PublicOrder & {
  guestName: string | null;
  decidedBy: string | null;
  kcplStatus: string;
  kcplError: string | null;
};

export function toPublicOrder(o: Order): PublicOrder {
  return {
    id: o.id,
    code: o.code,
    status: o.status,
    tableNumber: o.tableNumber,
    phone: o.phone,
    note: o.note,
    lines: o.lines as OrderLine[],
    itemCount: o.itemCount,
    subtotal: o.subtotal == null ? null : Number(o.subtotal),
    rejectReason: o.rejectReason,
    sentToFloor: o.kcplStatus === "sent",
    createdAt: o.createdAt,
    decidedAt: o.decidedAt,
  };
}

export function toStaffOrder(o: Order): StaffOrder {
  return {
    ...toPublicOrder(o),
    guestName: o.guestName,
    decidedBy: o.decidedBy,
    kcplStatus: o.kcplStatus,
    kcplError: o.kcplError,
  };
}

/** No 0/O or 1/I: the captain reads this aloud. */
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function newCode(): string {
  let s = "";
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `MM-${s}`;
}

/** Sends the cart for a captain to confirm. */
export async function place(
  session: Session,
  input: PlaceOrderInput,
  guest: { userId: string; name: string | null } | null,
): Promise<PublicOrder> {
  const view = await cart.view(session);
  if (view.totalItems === 0) {
    throw new AppError(422, "There's nothing in your order yet.", "CART_EMPTY");
  }

  const waiting = await prisma.order.count({ where: { sessionId: session.id, status: "pending" } });
  if (waiting >= env.ORDER_MAX_PENDING) {
    throw conflict(
      "A captain is already on the way for your earlier orders — they'll take this one too.",
      "TOO_MANY_PENDING",
    );
  }

  const lines: OrderLine[] = view.lines.map((l) => ({
    itemId: l.item.id,
    name: l.item.name,
    qty: l.qty,
    unitPrice: l.item.price,
    lineTotal: l.lineTotal,
  }));

  let order: Order | null = null;
  // Four characters from 32 is a million codes; a clash is rare, not impossible.
  for (let attempt = 0; !order; attempt++) {
    try {
      order = await prisma.order.create({
        data: {
          code: newCode(),
          sessionId: session.id,
          userId: guest?.userId ?? null,
          guestName: input.guestName ?? guest?.name ?? null,
          tableNumber: input.tableNumber ?? null,
          phone: input.phone ?? null,
          note: input.note ?? null,
          lines,
          itemCount: view.totalItems,
          subtotal: view.subtotal,
        },
      });
    } catch (err) {
      const clash = err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
      if (!clash || attempt >= 4) throw err;
    }
  }

  // The order holds these lines now. Emptied only after the row is written, so
  // a database error leaves the guest's cart exactly as it was.
  cart.clear(session);

  return toPublicOrder(await pushToKcpl(order));
}

/**
 * POSTs the order to KCPL and records whether it arrived.
 *
 * Never throws. A KCPL outage must not lose the order -- it is already in
 * Postgres and on the staff dashboard -- so the guest is still told a captain
 * is coming, and staff see a "not delivered to KCPL" flag beside it.
 */
async function pushToKcpl(order: Order): Promise<Order> {
  if (!env.KCPL_ORDER_WEBHOOK_URL) return order;

  const orderLines = order.lines as OrderLine[];
  const items = await prisma.item.findMany({
    where: { id: { in: orderLines.map((l) => l.itemId) } },
    select: { id: true, externalRef: true },
  });
  const posRef = new Map(items.map((i) => [i.id, i.externalRef]));

  const payload = {
    event: "order.created",
    order: {
      id: order.id,
      code: order.code,
      status: order.status,
      tableNumber: order.tableNumber,
      phone: order.phone,
      guestName: order.guestName,
      note: order.note,
      currency: "INR",
      itemCount: order.itemCount,
      subtotal: order.subtotal == null ? null : Number(order.subtotal),
      items: orderLines.map((l) => ({ ...l, posRef: posRef.get(l.itemId) ?? null })),
      createdAt: order.createdAt.toISOString(),
    },
    /** How KCPL tells us the captain accepted or rejected it. */
    callback: {
      method: "POST",
      url: `${env.PUBLIC_API_URL.replace(/\/$/, "")}/api/orders/${order.id}/decision`,
      header: "X-KCPL-Secret",
    },
  };

  let update: Prisma.OrderUpdateInput;
  try {
    const res = await fetch(env.KCPL_ORDER_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.KCPL_SHARED_SECRET ? { "X-Milli-Secret": env.KCPL_SHARED_SECRET } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(env.KCPL_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`KCPL answered ${res.status}`);
    const body = (await res.json().catch(() => null)) as { id?: unknown; ref?: unknown } | null;
    const ref = body?.id ?? body?.ref;
    update = { kcplStatus: "sent", kcplError: null, kcplRef: ref != null ? String(ref) : null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[order] ${order.code} not delivered to KCPL: ${message}`);
    update = { kcplStatus: "failed", kcplError: message.slice(0, 300) };
  }

  return prisma.order.update({ where: { id: order.id }, data: update });
}

/** A guest's own order, by id. Another session's id is simply not found. */
export async function get(session: Session, id: string): Promise<PublicOrder> {
  const order = await prisma.order.findFirst({ where: { id, sessionId: session.id } });
  if (!order) throw notFound("Order not found", "ORDER_NOT_FOUND");
  return toPublicOrder(order);
}

/** This visit's orders, newest first. */
export async function listForSession(session: Session): Promise<PublicOrder[]> {
  const rows = await prisma.order.findMany({
    where: { sessionId: session.id },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return rows.map(toPublicOrder);
}

/** The guest changed their mind before a captain reached them. */
export async function cancel(session: Session, id: string): Promise<PublicOrder> {
  const order = await prisma.order.findFirst({ where: { id, sessionId: session.id } });
  if (!order) throw notFound("Order not found", "ORDER_NOT_FOUND");
  return toPublicOrder(await decide(order.id, { status: "cancelled" }, "guest"));
}

/**
 * Accepts, rejects or cancels a pending order. Only `pending` moves: a captain
 * tapping accept twice, or KCPL retrying its callback, gets the order back
 * unchanged when the answer is the same, and a 409 when it contradicts it.
 */
export async function decide(
  id: string,
  decision: Pick<OrderDecisionInput, "reason" | "kcplRef"> & { status: "accepted" | "rejected" | "cancelled" },
  decidedBy: string,
): Promise<Order> {
  const { count } = await prisma.order.updateMany({
    where: { id, status: "pending" },
    data: {
      status: decision.status,
      decidedBy,
      decidedAt: new Date(),
      rejectReason: decision.status === "rejected" ? (decision.reason ?? null) : null,
      ...(decision.kcplRef ? { kcplRef: decision.kcplRef } : {}),
    },
  });

  const order = await prisma.order.findUnique({ where: { id } });
  if (!order) throw notFound("Order not found", "ORDER_NOT_FOUND");
  if (count === 0 && order.status !== decision.status) {
    throw conflict(`This order is already ${order.status}.`, "ORDER_ALREADY_DECIDED");
  }
  return order;
}

/** Staff dashboard: the last 24 hours, newest first, with counts by status. */
export async function listForStaff({ limit }: { limit: number }): Promise<{
  counts: Record<Order["status"], number>;
  orders: StaffOrder[];
}> {
  const since = new Date(Date.now() - 24 * 60 * 60_000);
  const [rows, grouped] = await Promise.all([
    prisma.order.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.order.groupBy({ by: ["status"], where: { createdAt: { gte: since } }, _count: true }),
  ]);

  const counts = { pending: 0, accepted: 0, rejected: 0, cancelled: 0 };
  for (const g of grouped) counts[g.status] = g._count;

  return { counts, orders: rows.map(toStaffOrder) };
}
