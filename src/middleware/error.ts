import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { Prisma } from "../../generated/prisma/client.ts";
import { AppError } from "../lib/errors.ts";
import { env } from "../lib/env.ts";

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    error: { code: "NOT_FOUND", message: `Cannot ${req.method} ${req.path}` },
  });
}

/** Maps the Prisma error codes our routes can actually produce. */
function fromPrisma(err: Prisma.PrismaClientKnownRequestError) {
  switch (err.code) {
    // Update/delete targeted a row that doesn't exist.
    case "P2025":
      return { status: 404, code: "NOT_FOUND", message: "Record not found" };
    // Unique constraint (duplicate email, category name, item name in category).
    case "P2002": {
      const target = err.meta?.["target"];
      const fields = Array.isArray(target) ? target.join(", ") : String(target ?? "field");
      return { status: 409, code: "DUPLICATE", message: `Already exists with that ${fields}` };
    }
    // FK violation, e.g. deleting a category that still has items.
    case "P2003":
      return { status: 409, code: "FK_CONSTRAINT", message: "Referenced record is still in use" };
    default:
      return null;
  }
}

// Express identifies error middleware by arity, so `next` must stay in the signature.
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(422).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request failed validation",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
    });
  }

  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const mapped = fromPrisma(err);
    if (mapped) {
      return res.status(mapped.status).json({
        error: { code: mapped.code, message: mapped.message },
      });
    }
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
