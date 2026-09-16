import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError } from "../lib/errors.ts";
import { env } from "../lib/env.ts";

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    error: { code: "NOT_FOUND", message: `Cannot ${req.method} ${req.path}` },
  });
}

// Express identifies error middleware by arity, so `next` must stay in the signature.
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(422).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request body failed validation",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
    });
  }

  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
  }

  console.error("Unhandled error:", err);

  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "Something went wrong",
      ...(env.NODE_ENV === "development" && err instanceof Error ? { debug: err.message } : {}),
    },
  });
}
