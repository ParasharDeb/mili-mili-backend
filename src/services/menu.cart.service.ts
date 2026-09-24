import { prisma } from "../../db/index.ts";
import { env } from "../lib/env.ts";
import { AppError, notFound } from "../lib/errors.ts";
import type { Session } from "../lib/session.ts";
import { toPublicItem, type PublicItem } from "./menu.items.service.ts";

/**
 * The cart.
 *
 * Lines store an item id and a quantity, nothing more. Names and prices are
 * re-read from Postgres on every view, so a dish that staff renamed or repriced
 * cannot sit stale in someone's order -- the copies kept on the line are for
 * showing a confirmation sentence, never for arithmetic.
 */

export type CartView = {
  lines: { item: PublicItem; qty: number; lineTotal: number | null }[];
  count: number;
  totalItems: number;
  subtotal: number | null;
  /** False when any line has no price, so the UI never shows a misleading total. */
  complete: boolean;
};

/** Reads the cart back, hydrated from the database. */
export async function view(session: Session): Promise<CartView> {
  if (session.cart.length === 0) {
    return { lines: [], count: 0, totalItems: 0, subtotal: 0, complete: true };
  }

  const rows = await prisma.item.findMany({
    where: { id: { in: session.cart.map((l) => l.itemId) } },
  });
  const byId = new Map(rows.map((r) => [r.id, toPublicItem(r)]));

  const lines: CartView["lines"] = [];
  let subtotal = 0;
  let complete = true;

  for (const line of session.cart) {
    const item = byId.get(line.itemId);
    if (!item) {
      // The dish was deleted from the menu while it sat in someone's cart.
      // Drop it rather than rendering a ghost.
      console.warn(`[cart] item ${line.itemId} no longer exists; dropping from cart`);
      continue;
    }
    const lineTotal = item.price != null ? item.price * line.qty : null;
    if (lineTotal == null) complete = false;
    else subtotal += lineTotal;
    lines.push({ item, qty: line.qty, lineTotal });
  }

  // Keep the session consistent with what we just showed.
  session.cart = session.cart.filter((l) => byId.has(l.itemId));

  return {
    lines,
    count: lines.length,
    totalItems: lines.reduce((n, l) => n + l.qty, 0),
    subtotal: complete ? subtotal : null,
    complete,
  };
}

/** Adds a dish, or increases its quantity if it is already there. */
export async function add(session: Session, itemId: string, qty = 1): Promise<PublicItem> {
  const row = await prisma.item.findUnique({ where: { id: itemId } });
  if (!row) throw notFound("Item not found", "ITEM_NOT_FOUND");

  if (!row.isActive || !row.isAvailable || row.soldOut) {
    throw new AppError(409, `${row.name} is not available tonight.`, "ITEM_UNAVAILABLE");
  }

  const item = toPublicItem(row);
  const existing = session.cart.find((l) => l.itemId === itemId);

  if (existing) {
    existing.qty = Math.min(20, existing.qty + qty);
  } else {
    if (session.cart.length >= env.CART_MAX_LINES) {
      throw new AppError(422, "That is as much as one order can hold.", "CART_FULL");
    }
    session.cart.push({
      itemId,
      name: item.name,
      qty: Math.max(1, Math.min(20, qty)),
      unitPrice: item.price,
      addedAt: Date.now(),
    });
  }

  session.lastSeenAt = Date.now();
  return item;
}

/**
 * Adds several dishes at once -- a whole combo, at the quantities the guest set.
 *
 * All or nothing: every line is checked before any is added, so a sold-out
 * kulcha rejects the combo with its name rather than leaving a curry with no
 * bread in the order. Zero-quantity lines are the guest dropping an item.
 */
export async function addMany(
  session: Session,
  lines: { itemId: string; qty: number }[],
): Promise<PublicItem[]> {
  const wanted = lines.filter((l) => l.qty > 0);
  if (wanted.length === 0) return [];

  const rows = await prisma.item.findMany({ where: { id: { in: wanted.map((l) => l.itemId) } } });
  const byId = new Map(rows.map((r) => [r.id, r]));

  for (const line of wanted) {
    const row = byId.get(line.itemId);
    if (!row) throw notFound("Item not found", "ITEM_NOT_FOUND");
    if (!row.isActive || !row.isAvailable || row.soldOut) {
      throw new AppError(409, `${row.name} is not available tonight.`, "ITEM_UNAVAILABLE");
    }
  }

  const newLines = wanted.filter((l) => !session.cart.some((c) => c.itemId === l.itemId)).length;
  if (session.cart.length + newLines > env.CART_MAX_LINES) {
    throw new AppError(422, "That is as much as one order can hold.", "CART_FULL");
  }

  const added: PublicItem[] = [];
  for (const line of wanted) added.push(await add(session, line.itemId, line.qty));
  return added;
}

/** Sets an exact quantity. Zero removes the line. */
export function setQuantity(session: Session, itemId: string, qty: number): void {
  const line = session.cart.find((l) => l.itemId === itemId);
  if (!line) throw notFound("That dish is not in your order", "CART_LINE_NOT_FOUND");

  if (qty <= 0) remove(session, itemId);
  else line.qty = Math.min(20, qty);

  session.lastSeenAt = Date.now();
}

export function remove(session: Session, itemId: string): void {
  const before = session.cart.length;
  session.cart = session.cart.filter((l) => l.itemId !== itemId);
  if (session.cart.length === before) {
    throw notFound("That dish is not in your order", "CART_LINE_NOT_FOUND");
  }
  session.lastSeenAt = Date.now();
}

export function clear(session: Session): void {
  session.cart = [];
  session.lastSeenAt = Date.now();
}
