import type { Request, Response } from "express";
import * as adminAuth from "../services/admin.auth.service.ts";
import * as userAuth from "../services/user.auth.service.ts";
import { unauthorized } from "../lib/errors.ts";

/** Resolves whichever principal the bearer token belongs to. */
export async function me(req: Request, res: Response) {
  if (!req.auth) throw unauthorized();

  const { id, role } = req.auth;
  const account = role === "admin" ? await adminAuth.getAdminById(id) : await userAuth.getUserById(id);

  // The token is valid but the row is gone (deleted account).
  if (!account) throw unauthorized("Account no longer exists", "ACCOUNT_NOT_FOUND");

  res.json({ role, account });
}
