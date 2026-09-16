import express from "express";
import { apiRouter } from "./routes/index.ts";
import { errorHandler, notFoundHandler } from "./middleware/error.ts";

export function createApp() {
  const app = express();

  app.use(express.json({ limit: "100kb" }));

  app.use("/api", apiRouter);

  // Order matters: 404 first, then the error handler last.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
