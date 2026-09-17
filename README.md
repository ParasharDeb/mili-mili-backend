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
| `POST` | `/auth/user/otp/verify` | `{ phone, code, name?, dietPreference? }` |

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

`dietPreference` is **required on the first verify** (signup) and ignored afterwards — an
unrecognised phone without one gets `400 DIET_PREFERENCE_REQUIRED`. Values:
`Vegeterian`, `Non_vegeterian`, `Eggeterian`, `OnlyFish`, `Jain`.

### Shared

| Method | Path | Auth |
| --- | --- | --- |
| `GET` | `/health` | — |
| `GET` | `/auth/me` | admin or user JWT |

Send the token as `Authorization: Bearer <token>`.

## Menu

### Public — what the user app browses

No auth required.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/menu/categories` | all active categories, with `itemCount` |
| `GET` | `/menu/categories/:id` | one category |
| `GET` | `/menu/items` | `?categoryId=<uuid>` to filter |
| `GET` | `/menu/items/:id` | one item |

```bash
curl localhost:3000/api/menu/categories
# { "categories": [ { "id", "name", "slug", "description",
#                     "imageUrl", "sortOrder", "isActive", "itemCount" } ] }
```

Inactive categories and unavailable items are hidden. An admin can pass
`?includeInactive=true` / `?includeUnavailable=true` **with an admin token** on these same
routes to see everything; the flags are ignored for anyone else.

### Admin — dashboard writes

Every route below requires `Authorization: Bearer <admin JWT>`. A user token gets `403`.

| Method | Path | Body |
| --- | --- | --- |
| `POST` | `/admin/menu/categories` | `{ name, description?, imageUrl?, sortOrder?, isActive? }` |
| `PATCH` | `/admin/menu/categories/:id` | any subset of the above |
| `DELETE` | `/admin/menu/categories/:id` | — |
| `POST` | `/admin/menu/items` | `{ name, price, categoryId, description?, imageUrl?, isAvailable? }` |
| `PATCH` | `/admin/menu/items/:id` | any subset |
| `DELETE` | `/admin/menu/items/:id` | — |

The edit you asked for — name, price, image, description:

```bash
curl -X PATCH localhost:3000/api/admin/menu/items/$ID   -H "authorization: Bearer $ADMIN_TOKEN"   -H 'content-type: application/json'   -d '{"name":"Paneer Tikka","price":"349.00",
       "imageUrl":"https://cdn.example.com/paneer.jpg",
       "description":"Char-grilled, 6 pieces"}'
```

`PATCH` is a true partial update: omit a field and it is untouched; send `null` for
`description` or `imageUrl` to clear it.

### Prices

Stored as `Decimal(10, 2)` and returned as a **2-decimal string** (`"349.00"`), not a number —
floats can't hold money exactly. On input both `349` and `"349.00"` are accepted; anything with
more than 2 decimals, negative, or in scientific notation is rejected.

Deleting a category that still has items returns `409 CATEGORY_NOT_EMPTY` rather than cascading.

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
  routes/                    index -> auth (admin/user) + menu (public/admin)
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

## Menu recommendations

`POST /api/menu/recommend` turns one sentence of party constraints into ranked
dish suggestions per constraint.

```bash
curl -X POST http://localhost:3000/api/menu/recommend   -H "Content-Type: application/json"   -d '{"query":"recommendations for 5 people. 2 veg, 1 non veg not spicy, 1 non veg spicy and one italian"}'
```

| Field | Default | Meaning |
| --- | --- | --- |
| `query` | required | The guest's request, 3-400 chars |
| `perSlot` | 3 | Ranked options returned per constraint |
| `includeDrinks` | false | Let every slot consider alcohol/shisha too |

A single embedding cannot express "2 veg AND 1 spicy non-veg", so the request is
split into **slots**, one per stated constraint. Each slot is embedded and queried
against Pinecone with its own metadata filter, then slots are filled
scarcity-first so a thin constraint is not starved by a greedier one.

`count` (guests covered) and `recommendations.length` (options offered) are
different numbers; "2 veg" means two guests choosing from three suggestions.

Notes worth knowing:

- **Diet filters are never relaxed.** When a slot cannot be filled the response
  carries `SLOT_NO_MATCHES` and an empty list rather than substituting something
  off-constraint. Everything else (spice band, then cuisine, then course) is
  relaxed one rung at a time and reported in `relaxations`.
- Results are re-verified against Postgres after retrieval. Pinecone metadata is
  only a snapshot that refreshes when someone re-runs `python ingest.py`, so an
  item edited in the database would otherwise keep matching its old filter.
- The keys are optional. Without `MISTRAL_API_KEY` / `PINECONE_API_KEY` the server
  still boots and only this route returns 503 `RECO_UNCONFIGURED`.
- If Mistral is unreachable the query falls back to a regex parser; the response
  reports which was used in `meta.parseMode`.

### Pairings — "what goes with this?"

`GET /api/menu/items/:id/pairings?limit=3` takes one item (the dish you just
ordered, or the drink you just picked) and returns the best matches from the
*other* side of the menu — dish in, drinks out; drink in, dishes out. Direction
is inferred from the item's own `course`, not passed in.

```bash
curl "http://localhost:3000/api/menu/items/$ITEM_ID/pairings?limit=3"
# { "item", "direction": "food_to_drink" | "drink_to_food",
#   "pairings": [ { "rank", "score", "why", "item" } ], "meta" }
```

Ranking blends two signals: Pinecone semantic similarity (embeds the item's own
name/desc/tags, same embedding space `python ingest.py` writes) and a small
deterministic flavour-affinity table over `spice` / `tasteTags` / `protein` —
spicy wants something cooling, rich/creamy wants something to cut it, smoky
echoes smoky, dessert wants sweet. `why` is generated from that table, not an
LLM call, for the same hallucination-risk reason as `recommend`'s `explain()`.

`Shisha` items return `422 PAIRING_NOT_SUPPORTED` — hookah pairing isn't
modelled. An unknown id is `404 ITEM_NOT_FOUND`; an unconfigured Mistral/Pinecone
is `503 RECO_UNCONFIGURED`, same as `/recommend`.
