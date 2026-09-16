import { prisma } from "../../db/index.ts";
import { hashPassword, verifyPassword } from "../lib/password.ts";
import { signToken } from "../lib/jwt.ts";
import { conflict, unauthorized } from "../lib/errors.ts";
import type { AdminLoginInput, AdminRegisterInput } from "../schemas/auth.schema.ts";

const publicAdmin = (admin: { id: string; email: string; name: string | null; createdAt: Date }) => ({
  id: admin.id,
  email: admin.email,
  name: admin.name,
  createdAt: admin.createdAt,
});

export async function registerAdmin(input: AdminRegisterInput) {
  const existing = await prisma.admin.findUnique({ where: { email: input.email } });
  if (existing) throw conflict("An admin with that email already exists", "EMAIL_TAKEN");

  const admin = await prisma.admin.create({
    data: {
      email: input.email,
      passwordHash: await hashPassword(input.password),
      name: input.name ?? null,
    },
  });

  return { admin: publicAdmin(admin) };
}

export async function loginAdmin(input: AdminLoginInput) {
  const admin = await prisma.admin.findUnique({ where: { email: input.email } });

  // Hash even when the email is unknown, so response time doesn't leak which
  // emails are registered.
  const passwordHash = admin?.passwordHash ?? "$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv";
  const ok = await verifyPassword(input.password, passwordHash);

  if (!admin || !ok) throw unauthorized("Invalid email or password", "INVALID_CREDENTIALS");

  return {
    token: await signToken({ sub: admin.id, role: "admin" }),
    admin: publicAdmin(admin),
  };
}

export async function getAdminById(id: string) {
  const admin = await prisma.admin.findUnique({ where: { id } });
  return admin ? publicAdmin(admin) : null;
}
