/** An error with an HTTP status that is safe to surface to the client. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (msg: string, code = "BAD_REQUEST", details?: unknown) =>
  new AppError(400, msg, code, details);

export const unauthorized = (msg = "Unauthorized", code = "UNAUTHORIZED") =>
  new AppError(401, msg, code);

export const forbidden = (msg = "Forbidden", code = "FORBIDDEN") =>
  new AppError(403, msg, code);

export const notFound = (msg = "Not found", code = "NOT_FOUND") =>
  new AppError(404, msg, code);

export const conflict = (msg: string, code = "CONFLICT") => new AppError(409, msg, code);

export const tooManyRequests = (msg: string, code = "TOO_MANY_REQUESTS") =>
  new AppError(429, msg, code);
