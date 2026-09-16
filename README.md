# backend

Bun + Express 5 + Prisma 7 (PostgreSQL / Neon), with two auth flows:

- **Admins** — email + password (bcrypt, 12 rounds)
- **Users** — phone number + 6-digit OTP

Both issue a JWT (HS256, via `jose`). All request bodies are validated with zod.

## Setup

```bash
bun install
cp .env.example .env     # then fill it in
bun run db:migrate       # create tables on Neon
SEED_ADMIN_PASSWORD='choose-a-strong-one' bun run db:seed
bun run dev
```

### Neon connection strings

Neon console → your project → **Connect**:

| Var | Neon host | Used by |
| --- | --- | --- |
| `DATABASE_URL` | pooled (`...-pooler...`) | the app at runtime |
| `DIRECT_URL` | direct (no `-pooler`) | Prisma CLI: migrations, studio |

Migrations don't run reliably through Neon's PgBouncer pooler, hence the split.

## API

Base path `/api`. Errors are always `{ "error": { "code", "message", "details"? } }`.

### Admin — email + password

| Method | Path | Auth | Body |
| --- | --- | --- | --- |
| `POST` | `/auth/admin/login` | — | `{ email, password }` |
| `POST` | `/auth/admin/register` | admin JWT | `{ email, password, name? }` |

`register` is deliberately admin-only — only an existing admin can mint another.
The first admin comes from `bun run db:seed`.

```bash
curl -X POST localhost:3000/api/auth/admin/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"..."}'
# -> { "token": "...", "admin": { "id", "email", "name", "createdAt" } }
```

### User — phone + OTP

Signup and login are the same two calls; a user row is created on first successful verify.

| Method | Path | Body |
| --- | --- | --- |
| `POST` | `/auth/user/otp/request` | `{ phone }` |
| `POST` | `/auth/user/otp/verify` | `{ phone, code, name? }` |

```bash
curl -X POST localhost:3000/api/auth/user/otp/request \
  -H 'content-type: application/json' -d '{"phone":"+919876543210"}'
# 202 -> { "expiresAt": "...", "devCode": "483920" }   devCode only when NODE_ENV != production

curl -X POST localhost:3000/api/auth/user/otp/verify \
  -H 'content-type: application/json' \
  -d '{"phone":"+919876543210","code":"483920"}'
# 201 (new user) or 200 -> { "token", "user", "isNewUser" }
```

Phone numbers must be E.164 (`+` country code, 8–15 digits).

### Shared

| Method | Path | Auth |
| --- | --- | --- |
| `GET` | `/health` | — |
| `GET` | `/auth/me` | admin or user JWT |

Send the token as `Authorization: Bearer <token>`.

## OTP behaviour

Codes are random 6 digits, **bcrypt-hashed before storage** — plaintext codes are never persisted.

| Env var | Default | Effect |
| --- | --- | --- |
| `OTP_TTL_MINUTES` | 5 | code lifetime |
| `OTP_MAX_ATTEMPTS` | 5 | wrong guesses before the code is locked |
| `OTP_RESEND_COOLDOWN_SECONDS` | 60 | throttle on re-requesting |

Requesting a new code invalidates any previous outstanding code for that number.

**SMS delivery is a stub.** `src/services/sms.service.ts` logs the code in development and
throws in production — wire up Twilio/MSG91 there before deploying.

## Layout

```
index.ts                     server entry (listen + graceful shutdown)
db/index.ts                  PrismaClient singleton (pg driver adapter)
prisma/schema.prisma         Admin, User, OtpCode
prisma/seed.ts               creates the first admin
src/
  app.ts                     express app factory
  routes/                    index -> admin.auth / user.auth
  controllers/               thin: parse result -> status + json
  services/                  business logic + all DB access
  middleware/                validate (zod), auth (JWT), error
  schemas/auth.schema.ts     zod request schemas
  lib/                       env, errors, jwt, password
```

Routers mount in `src/routes/index.ts`; controllers never touch Prisma directly.

## Scripts

| Script | Description |
| --- | --- |
| `bun run dev` | hot-reloading server |
| `bun run start` | run once |
| `bun run db:migrate` | create & apply a migration (dev) |
| `bun run db:deploy` | apply migrations (prod/CI) |
| `bun run db:seed` | create the first admin |
| `bun run db:studio` | Prisma Studio |
| `bun run db:generate` | regenerate the client after schema edits |
