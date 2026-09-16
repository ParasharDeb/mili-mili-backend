import type { Request, Response } from "express";
import * as userAuth from "../services/user.auth.service.ts";
import type { RequestOtpInput, VerifyOtpInput } from "../schemas/auth.schema.ts";

export async function requestOtp(req: Request, res: Response) {
  const result = await userAuth.requestOtp(req.body as RequestOtpInput);
  res.status(202).json(result);
}

export async function verifyOtp(req: Request, res: Response) {
  const result = await userAuth.verifyOtp(req.body as VerifyOtpInput);
  res.status(result.isNewUser ? 201 : 200).json(result);
}
