import { Pinecone } from "@pinecone-database/pinecone";
import { env } from "./env.ts";

/** One match from the menu index. `metadata` mirrors rag/menu_rag/documents.py. */
export type ItemMatch = {
  id: string;
  score: number;
  name: string;
  course: string;
  diet: string;
  cuisine: string;
  spice: number;
};

// `pc.index()` does a control-plane describeIndex on first use; under `bun --hot`
// that would fire on every reload. Cached the same way db/index.ts caches Prisma.
const globalForPinecone = globalThis as unknown as { pinecone?: Pinecone };

function client(): Pinecone {
  const existing = globalForPinecone.pinecone;
  if (existing) return existing;

  const pc = new Pinecone({ apiKey: env.PINECONE_API_KEY });
  if (env.NODE_ENV !== "production") globalForPinecone.pinecone = pc;
  return pc;
}

/**
 * Single seam for vector retrieval. At 435 vectors this could just as well be an
 * in-memory cosine scan; keeping it behind one function makes that a one-file swap.
 */
export async function queryItems(
  vector: number[],
  filter: Record<string, unknown> | undefined,
  topK: number,
): Promise<ItemMatch[]> {
  const index = client().index(env.PINECONE_INDEX).namespace(env.PINECONE_NAMESPACE);

  const res = await index.query({
    vector,
    topK,
    includeMetadata: true,
    // Never pull the 1024 floats back — pure payload for no benefit.
    includeValues: false,
    ...(filter ? { filter } : {}),
  });

  return (res.matches ?? []).map((m) => {
    const meta = (m.metadata ?? {}) as Record<string, unknown>;
    return {
      id: m.id,
      score: m.score ?? 0,
      name: String(meta.name ?? ""),
      course: String(meta.course ?? ""),
      diet: String(meta.diet ?? ""),
      cuisine: String(meta.cuisine ?? ""),
      spice: Number(meta.spice ?? 0),
    };
  });
}
