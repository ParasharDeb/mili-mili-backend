# syntax=docker/dockerfile:1

# ---- deps: install all packages (prisma CLI is a devDependency, needed to generate) ----
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---- build: generate the Prisma client into ./generated/prisma ----
FROM deps AS build
COPY . .
# prisma generate doesn't connect, but the config reads a URL; give it a placeholder.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" bunx prisma generate --config prisma7.config.ts

# ---- prod-deps: runtime packages only ----
FROM oven/bun:1 AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- runtime ----
FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4000

COPY --from=prod-deps --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/generated ./generated
COPY --chown=bun:bun package.json tsconfig.json index.ts ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun db ./db
COPY --chown=bun:bun public ./public

USER bun
EXPOSE 4000

CMD ["bun", "run", "index.ts"]
