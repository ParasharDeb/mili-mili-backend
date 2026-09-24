import type { NextFunction, Request, Response } from "express";
import { getSession } from "../lib/session.ts";

/**
 * Resolves `X-Session-Id` into `req.session`.
 *
 * A header, not a cookie. The browser talks to Next, which proxies /api to this
 * server, and `Set-Cookie` surviving that rewrite is an implementation detail of
 * the dev proxy rather than a contract -- the API client also runs from React
 * Server Components, where there is no cookie jar at all. A client-generated
 * uuid in localStorage needs no SameSite tuning, carries no ambient credential
 * to be forged, and survives a tab duplication.
 *
 * An unknown id is never an error; it mints a fresh session under that id, so a
 * server restart costs a guest their cart and nothing else.
 */
export function withSession(req: Request, res: Response, next: NextFunction): void {
  const header = req.get("x-session-id");
  const session = getSession(typeof header === "string" && header.length <= 64 ? header : null);

  req.session = session;
  // Echo it back so a client that sent nothing (curl, a first visit) learns its id.
  res.setHeader("X-Session-Id", session.id);
  next();
}
