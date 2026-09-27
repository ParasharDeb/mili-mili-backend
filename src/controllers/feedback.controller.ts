import type { Request, Response } from "express";
import type { FeedbackInput } from "../schemas/feedback.schema.ts";
import { loadGuest } from "../services/concierge.service.ts";
import * as feedback from "../services/feedback.service.ts";

export async function ask(req: Request, res: Response) {
  res.json(feedback.feedbackAsk(req.session, await loadGuest(req.auth)));
}

export async function submit(req: Request, res: Response) {
  const guest = await loadGuest(req.auth);
  const { answer, chips, tier, escalate } = await feedback.submitFeedback(
    req.session,
    guest,
    req.body as FeedbackInput,
  );
  res.status(201).json({ answer, chips, tier, escalate });
}
