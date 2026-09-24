import { fileURLToPath } from "node:url";
import express from "express";
import { apiRouter } from "./routes/index.ts";
import { errorHandler, notFoundHandler } from "./middleware/error.ts";

export function createApp() {
  const app = express();

  app.use(express.json({ limit: "100kb" }));

  // Dish photographs extracted from the POS export by prisma/seedItems.ts.
  // Served under /api so the Next rewrite proxies them with everything else --
  // the browser never learns the backend has its own origin.
  app.use(
    "/api/media",
    express.static(fileURLToPath(new URL("../public/media", import.meta.url)), {
      maxAge: "7d",
      fallthrough: true,
    }),
  );

  app.use("/api", apiRouter);

  // Order matters: 404 first, then the error handler last.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
