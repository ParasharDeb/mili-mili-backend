import { prisma } from "../db/index.ts";
import { hashPassword } from "../src/lib/password.ts";

// Creates the first admin, who can then create others via POST /api/auth/admin/register.
const email = process.env.SEED_ADMIN_EMAIL ?? "admin@example.com";
const password = process.env.SEED_ADMIN_PASSWORD;

if (!password) {
  throw new Error("Set SEED_ADMIN_PASSWORD before seeding, e.g. SEED_ADMIN_PASSWORD=... bun run db:seed");
}

const admin = await prisma.admin.upsert({
  where: { email },
  create: { email, passwordHash: await hashPassword(password), name: "Root Admin" },
  update: {},
});

console.log(`Seeded admin: ${admin.email}`);
await prisma.$disconnect();
