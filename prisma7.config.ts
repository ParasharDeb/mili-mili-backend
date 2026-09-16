import "dotenv/config";
import { defineConfig } from "prisma/config";

// The CLI (migrate/db pull/studio) talks to Neon over the DIRECT, unpooled host.
// Migrations don't work reliably through PgBouncer. The app itself uses the
// pooled DATABASE_URL via db/index.ts.
const url = process.env["DIRECT_URL"] || process.env["DATABASE_URL"];

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url,
  },
});
