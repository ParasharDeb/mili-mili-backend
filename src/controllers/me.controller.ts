import type { Request, Response } from "express";
import * as adminAuth from "../services/admin.auth.service.ts";
import * as userAuth from "../services/user.auth.service.ts";
import { forbidden, unauthorized } from "../lib/errors.ts";
import { prisma } from "../../db/index.ts";
import type { PreferencesInput } from "../schemas/feedback.schema.ts";

/** Resolves whichever principal the bearer token belongs to. */
export async function me(req: Request, res: Response) {
  if (!req.auth) throw unauthorized();

  const { id, role } = req.auth;
  const account = role === "admin" ? await adminAuth.getAdminById(id) : await userAuth.getUserById(id);

  // The token is valid but the row is gone (deleted account).
  if (!account) throw unauthorized("Account no longer exists", "ACCOUNT_NOT_FOUND");

  res.json({ role, account });
}

/** Marketing is opt-in and separate from the chat; the concierge never markets. */
export async function updatePreferences(req: Request, res: Response) {
  if (!req.auth || req.auth.role !== "user") throw forbidden("Only guests have preferences");

  const { marketingOptIn } = req.body as PreferencesInput;
  const user = await prisma.user.update({
    where: { id: req.auth.id },
    data: { marketingOptIn, marketingOptInAt: marketingOptIn ? new Date() : null },
    select: { marketingOptIn: true, marketingOptInAt: true },
  });
  res.json(user);
}
