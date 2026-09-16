import type { Request, Response } from "express";
import * as adminAuth from "../services/admin.auth.service.ts";
import type { AdminLoginInput, AdminRegisterInput } from "../schemas/auth.schema.ts";

export async function register(req: Request, res: Response) {
  const result = await adminAuth.registerAdmin(req.body as AdminRegisterInput);
  res.status(201).json(result);
}

export async function login(req: Request, res: Response) {
  const result = await adminAuth.loginAdmin(req.body as AdminLoginInput);
  res.json(result);
}
