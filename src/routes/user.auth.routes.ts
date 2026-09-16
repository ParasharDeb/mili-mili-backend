import { Router } from "express";
import * as controller from "../controllers/user.auth.controller.ts";
import { validateBody } from "../middleware/validate.ts";
import { requestOtpSchema, verifyOtpSchema } from "../schemas/auth.schema.ts";

export const userAuthRouter = Router();

// Signup and login are the same flow: request a code, then verify it.
userAuthRouter.post("/otp/request", validateBody(requestOtpSchema), controller.requestOtp);
userAuthRouter.post("/otp/verify", validateBody(verifyOtpSchema), controller.verifyOtp);
