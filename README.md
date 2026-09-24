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
`Vegetarian`, `NonVegetarian`, `Eggetarian`, `OnlyFish`, `Jain`.

### Shared

| Method | Path | Auth |
| --- | --- | --- |
| `GET` | `/health` | — |
| `GET` | `/auth/me` | admin or user JWT |

Send the token as `Authorization: Bearer <token>`.

## Menu

The menu lives in one table, `items`. The `categories`/`menu_items` pair this
README used to document was dropped in migration `20260917091044`; the routes
that went with it no longer exist.

| Route | Purpose |
| --- | --- |
| `GET /api/menu/items` | The menu, grouped by course. Filters: `group`, `course`, `diet`, `q`, `maxPrice`, `partySize`, `tag` |
| `GET /api/menu/stats` | Composition counts for the staff dashboard |
| `GET /api/menu/items/:id/pairings` | What goes with this dish, or this drink |
| `POST /api/menu/chat` | One door for the chat UI -- see below |
| `POST /api/menu/recommend` | Slot recommendations, for callers that already know |
| `GET/POST/PATCH/DELETE /api/cart` | The guest's order |

Every guest-facing query is filtered to `is_active AND is_available AND NOT
sold_out`. Prices are `Decimal(10,2)` and are converted with `.toNumber()` in
`toPublicItem` -- a Prisma `Decimal` does not `JSON.stringify` into a number.

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
prisma/schema.prisma         Admin, User, OtpCode, Item
prisma/seed.ts               creates the first admin
prisma/seedItems.ts          POS export -> Postgres (the only normalisation point)
prisma/classifyItem.ts       regex classifier for what the POS never captured
prisma/enrich.ts             Mistral re-derives spice, taste, cuisine, diet
src/
  app.ts                     express app factory
  domain/                    menu.constants, diet.hardrules (name beats model)
  routes/                    index -> auth + menu + cart
  controllers/               thin: parse result -> status + json
  services/
    menu.route.service.ts    Jev classifies the turn
    menu.slots.service.ts    splits a request, resolves each part
    menu.sql.service.ts      all retrieval (replaces the vector index)
    menu.rank.ts             pure scoring, no I/O
    menu.filter.ts           slot -> Prisma where; the diet semantics live here
    menu.chat.service.ts     the dispatcher
    menu.advise.service.ts   whole menu -> LLM, for judgement calls
    menu.reference.ts        "yes, the first one" -> a dish
    menu.cart.service.ts     the order
  middleware/                validate (zod), auth (JWT), session, error
  lib/                       env, errors, jwt, password, mistral, jev, session
tests/                       bun test -- the pure modules
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
| `bun run db:seed:items` | POS export -> Postgres. Pass `--skip-images` to go fast |
| `bun run db:enrich` | Mistral fills spice/taste/cuisine. Run AFTER seeding |
| `bun run db:rules` | Re-apply the deterministic guards, no model calls |
| `bun test` | the pure modules: diet mapping, slots, referents, ranking |
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

One query cannot express "2 veg AND 1 spicy non-veg", so the request is split
into **slots**, one per stated constraint. Splitting and counting are regex --
exact, and a classifier's weakest axis. Each slot becomes its own SQL query
(`menu.filter.ts` -> `menu.sql.service.ts`), and slots are then filled
scarcity-first so a thin constraint is not starved by a greedier one.

`count` (guests covered) and `recommendations.length` (options offered) are
different numbers; "2 veg" means two guests choosing from three suggestions.

Notes worth knowing:

- **Diet filters are never relaxed.** When a slot cannot be filled the response
  carries `SLOT_NO_MATCHES` and an empty list rather than substituting something
  off-constraint. Everything else (spice band, then cuisine, then course) is
  relaxed one rung at a time and reported in `relaxations`.
- Results are re-verified against Postgres after retrieval with `dietAllows`.
  That check is now tautological -- the query built the set -- and it stays
  anyway: it is the last line of defence against a bug in the filter, and it is
  what makes a classifier that falls back to `diet: "any"` safe.
- **Recommendations need no API key.** They are SQL. Only the two prose paths
  (the grounded answer and the advisory combo) need `MISTRAL_API_KEY`.
- Ranking is deterministic and explainable (`menu.rank.ts`): trigram and
  full-text similarity from Postgres, combined in TypeScript with tag overlap,
  spice proximity, cuisine and popularity. The same question ranks the same way
  twice, which the vector path never did.
- If Jev is unreachable or unconfigured, routing and slotting fall back to
  regex. The response reports which ran in `meta.routeMode` / `meta.slotMode`.

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

Ranking is a deterministic flavour-affinity table over `spice` / `tasteTags` /
`protein` — spicy wants something cooling, rich/creamy wants something to cut it,
smoky echoes smoky, dessert wants sweet. `why` is generated from that table, not
an LLM call, for the same hallucination-risk reason as `recommend`'s `explain()`.

This used to blend the affinity table with an embedding, weighted 0.45/0.55. The
embedding did real work here -- it carried world knowledge a tag table cannot,
reading "Laphroaig" as smoky from a bare product name -- so removing it is a
genuine regression for plain spirits, which the enrichment leaves nearly
tag-less. Known and accepted, not overlooked.

`Shisha` items return `422 PAIRING_NOT_SUPPORTED` — hookah pairing isn't
modelled. An unknown id is `404 ITEM_NOT_FOUND`. No API key is required.
