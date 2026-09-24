import { randomUUID } from "node:crypto";
import { env } from "./env.ts";

/**
 * In-memory conversation and cart state.
 *
 * Deliberately not in Postgres. A cart here is a working note for one visit, not
 * a record: it holds no money movement and no personal data, and the cost of
 * losing it on a restart is that a guest re-adds two dishes. That trade was made
 * explicitly; what it buys is that nothing in this file can fail, block, or need
 * a migration.
 *
 * The consequence to be honest about: this is single-process. A second instance
 * behind a load balancer would hand the same guest a different cart.
 */

export type OfferedDish = {
  /** 1-based, in the order the UI renders them. "The second one" indexes this. */
  ordinal: number;
  id: string;
  name: string;
  nameKey: string;
  diet: string;
  protein: string;
  spice: number;
  spiceConfidence: number | null;
  price: number | null;
};

export type CartLine = {
  itemId: string;
  name: string;
  qty: number;
  unitPrice: number | null;
  addedAt: number;
};

export type Turn = { role: "guest" | "bot"; text: string; at: number };

export type Session = {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  /** Last few turns, for the classifier's state. Capped so it cannot grow. */
  turns: Turn[];
  /** What the assistant put in front of the guest last. The basis of "yes, that one". */
  lastOffer: {
    at: number;
    turnIndex: number;
    kind: string;
    dishes: OfferedDish[];
  } | null;
  cart: CartLine[];
  /**
   * The combos last shown, with their suggested quantities. What "add combo 2"
   * resolves against -- a chat message cannot carry the UI's stepper state.
   */
  lastCombos?: { title: string; lines: { itemId: string; qty: number }[] }[] | null;
};

const MAX_TURNS = 6;
const MAX_OFFERED = 12;

/**
 * Pinned to `globalThis` for the same reason db/index.ts pins the Prisma client:
 * `bun run --hot` re-imports this module on every save, and a plain module-level
 * Map would drop every cart each time a developer touches a file.
 */
const globalForSessions = globalThis as unknown as {
  __sessions?: Map<string, Session>;
  __sessionSweeper?: NodeJS.Timeout;
};

const sessions: Map<string, Session> = (globalForSessions.__sessions ??= new Map());

const ttlMs = () => env.SESSION_TTL_MINUTES * 60_000;

function isExpired(session: Session, now = Date.now()): boolean {
  return now - session.lastSeenAt > ttlMs();
}

function sweep(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (isExpired(session, now)) sessions.delete(id);
  }

  // Hard cap, oldest first, in case sweeping alone cannot keep up.
  if (sessions.size > env.SESSION_MAX) {
    const byAge = [...sessions.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
    for (const [id] of byAge.slice(0, sessions.size - env.SESSION_MAX)) sessions.delete(id);
  }
}

// `unref()` matters: without it this timer keeps the process alive, and `bun
// test` hangs at the end of a run that happened to import this module.
if (!globalForSessions.__sessionSweeper) {
  globalForSessions.__sessionSweeper = setInterval(sweep, 5 * 60_000);
  globalForSessions.__sessionSweeper.unref?.();
}

function create(id: string = randomUUID()): Session {
  const now = Date.now();
  const session: Session = {
    id,
    createdAt: now,
    lastSeenAt: now,
    turns: [],
    lastOffer: null,
    cart: [],
  };
  sessions.set(id, session);
  return session;
}

/**
 * Returns the session for this id, creating one if it is unknown or expired.
 *
 * An unrecognised id is never an error. The id is a client-generated uuid held
 * in localStorage, so a cleared browser, a new device or a server restart all
 * arrive here the same way, and the right answer to all of them is a fresh cart
 * rather than a 404 the UI has to handle.
 */
export function getSession(id?: string | null): Session {
  if (id) {
    const existing = sessions.get(id);
    if (existing && !isExpired(existing)) {
      // Sliding expiry: a guest mid-meal must not lose their order to a clock
      // that started when they said hello.
      existing.lastSeenAt = Date.now();
      return existing;
    }
    if (existing) sessions.delete(id);
    // Honour the client's id so a reload keeps the same key.
    return create(id);
  }
  return create();
}

export function recordTurn(session: Session, role: Turn["role"], text: string): void {
  session.turns.push({ role, text: text.slice(0, 400), at: Date.now() });
  if (session.turns.length > MAX_TURNS) session.turns.splice(0, session.turns.length - MAX_TURNS);
  session.lastSeenAt = Date.now();
}

/**
 * Records what was just put in front of the guest, with ordinals.
 *
 * Every branch that shows dishes must call this, or the next turn's "yes, the
 * first one" has nothing to resolve against.
 */
export function recordOffer(
  session: Session,
  kind: string,
  dishes: Omit<OfferedDish, "ordinal">[],
): void {
  if (dishes.length === 0) return;
  session.lastOffer = {
    at: Date.now(),
    turnIndex: session.turns.length,
    kind,
    dishes: dishes.slice(0, MAX_OFFERED).map((d, i) => ({ ...d, ordinal: i + 1 })),
  };
}

/** Test and diagnostics only. */
export function _reset(): void {
  sessions.clear();
}

export function sessionCount(): number {
  return sessions.size;
}
