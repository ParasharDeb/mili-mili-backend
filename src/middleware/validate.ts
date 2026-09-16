import type { NextFunction, Request, Response } from "express";
import type { ZodType } from "zod";

/**
 * Validates `req.body` and replaces it with the parsed result, so controllers
 * receive trimmed/coerced data with an exact type.
 */
export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) return next(result.error);

    req.body = result.data;
    next();
  };
}

/** Validates route params (`:id`) in place. */
export function validateParams<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.params);
    if (!result.success) return next(result.error);

    req.params = result.data as typeof req.params;
    next();
  };
}

/**
 * Validates the query string. Express 5 makes `req.query` a read-only getter,
 * so the parsed value lands on `req.validatedQuery` instead of overwriting it.
 */
export function validateQuery<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) return next(result.error);

    req.validatedQuery = result.data;
    next();
  };
}
