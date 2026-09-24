/**
 * POS export -> Postgres. The single normalisation point for the menu.
 *
 *   bun run prisma/seedItems.ts [--skip-images] [--limit N]
 *
 * Run order matters: this re-runs the heuristic classifier, so it must come
 * BEFORE `prisma/enrich.ts`, which replaces the spice and taste it cannot
 * derive. Re-seeding after enriching throws the enrichment away.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { classifyItem, isInlineImage, type ClassifiedItem, type SourceItem } from "./classifyItem.ts";
import { prisma } from "../db/index.ts";

const args = new Set(process.argv.slice(2));
const skipImages = args.has("--skip-images");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : Infinity;

/** Express serves this at /api/media, so the Next rewrite proxies it unchanged. */
const IMAGE_DIR = new URL("../public/media/items/", import.meta.url);
const IMAGE_URL_PREFIX = "/api/media/items";

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

/**
 * Writes an inline `data:` image to disk and returns the path to store.
 *
 * Keeping the base64 in Postgres would mean re-reading tens of megabytes on
 * every menu page load, because Prisma selects all scalar fields by default.
 */
async function extractImage(dataUri: string, key: string): Promise<string | null> {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUri);
  if (!match) return null;

  const ext = EXTENSIONS[match[1]!.toLowerCase()];
  if (!ext) {
    console.warn(`[seed] unsupported inline image type "${match[1]}" on ${key}`);
    return null;
  }

  const file = `${key}.${ext}`;
  await writeFile(new URL(file, IMAGE_DIR), Buffer.from(match[2]!, "base64"));
  return `${IMAGE_URL_PREFIX}/${file}`;
}

const raw = await readFile(new URL("../data.json", import.meta.url), "utf8");
const sourceItems: SourceItem[] = JSON.parse(raw);

if (!skipImages) await mkdir(IMAGE_DIR, { recursive: true });

const rows: ClassifiedItem[] = [];
let imagesWritten = 0;

for (const source of sourceItems.slice(0, limit)) {
  const item = classifyItem(source);

  if (isInlineImage(source.image_url)) {
    if (skipImages) {
      // `classifyItem` nulls an inline image, because a data: URI must never
      // reach Postgres. Under --skip-images we have not written a file to point
      // at either, so drop the key entirely and let any path from a previous
      // full run survive the upsert -- the flag is there to make re-seeding
      // fast, not to wipe the photographs.
      delete (item as { imageUrl?: string | null }).imageUrl;
    } else {
      const path = await extractImage(source.image_url!, source.external_ref || source.id);
      if (path) {
        item.imageUrl = path;
        imagesWritten++;
      }
    }
  }

  rows.push(item);
}

/**
 * Upsert on (source, externalRef) where we have one: POS ids can change between
 * exports, but `external_ref` is stable, so a re-import updates rather than
 * duplicating. Rows with no external ref fall back to the primary key.
 *
 * Deliberately NOT wrapped in $transaction. The app connects through Neon's
 * PgBouncer pooler, which will not hold an interactive transaction open long
 * enough for a batch of upserts -- Prisma gives up with P2028. Concurrent
 * single-statement upserts are both faster and compatible with the pooler, and
 * a half-finished seed is recoverable by simply running it again.
 */
const CONCURRENCY = 10;
let written = 0;

const upsert = (item: ClassifiedItem) =>
  item.externalRef
    ? prisma.item.upsert({
        where: { item_source_ref: { source: item.source, externalRef: item.externalRef } },
        create: item,
        update: item,
      })
    : prisma.item.upsert({ where: { id: item.id }, create: item, update: item });

for (let i = 0; i < rows.length; i += CONCURRENCY) {
  await Promise.all(rows.slice(i, i + CONCURRENCY).map(upsert));
  written += Math.min(CONCURRENCY, rows.length - i);
  process.stdout.write(`\r[seed] ${written}/${rows.length}`);
}

process.stdout.write("\n");

const unassessed = rows.filter((r) => r.spiceConfidence == null).length;
console.log(`[seed] ${written} items from data.json`);
if (!skipImages) console.log(`[seed] ${imagesWritten} inline images written to public/media/items/`);
console.log(
  `[seed] ${unassessed} items have no assessed spice level. ` +
    `Run \`bun run db:enrich\` next, or spice-filtered queries will be weak.`,
);

await prisma.$disconnect();
