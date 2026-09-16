import type { NextFunction, Request, Response } from "express";
import type { ZodType } from "zod";

/**
 * Validates `req.body` against `schema` and replaces it with the parsed result,
 * so controllers receive trimmed/coerced data with an exact type.
 */
export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      // Handled by the error middleware, which knows how to shape ZodError.
      return next(result.error);
    }

    req.body = result.data;
    next();
  };
}
