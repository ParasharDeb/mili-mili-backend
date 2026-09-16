import { createApp } from "./src/app.ts";
import { env } from "./src/lib/env.ts";
import { prisma } from "./db/index.ts";

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`Listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
  });
}
