import { env } from "./env.ts";
import { AppError } from "./errors.ts";

/**
 * Minimal Mistral client.
 *
 * Deliberately plain `fetch` rather than `@mistralai/mistralai`: that SDK ships
 * its own zod v3, and this backend is on zod v4. Query time needs exactly two
 * calls, so the SDK buys nothing worth a duplicated schema library.
 */

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

async function call(path: string, body: unknown, timeoutMs: number): Promise<any> {
  let lastError = "";

  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${env.MISTRAL_BASE_URL}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.MISTRAL_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === 2) break;
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt + Math.random() * 300));
      continue;
    }

    if (res.ok) return res.json();

    lastError = `${res.status} ${(await res.text()).slice(0, 200)}`;
    if (!RETRYABLE.has(res.status) || attempt === 2) break;
    await new Promise((r) => setTimeout(r, 400 * 2 ** attempt + Math.random() * 300));
  }

  throw new AppError(503, `Mistral request failed: ${lastError}`, "MISTRAL_UNAVAILABLE");
}

/**
 * Chat completion constrained to a JSON object. Returns the parsed value.
 *
 * The defaults suit a single request/response turn. `prisma/enrich.ts` catalogues
 * dishes fifteen at a time and needs both a bigger budget and a longer timeout,
 * hence the options -- a batch that runs out of tokens comes back as truncated
 * JSON, which surfaces as MISTRAL_BAD_JSON and costs the whole batch.
 */
export async function chatJson(
  messages: ChatMessage[],
  opts: { maxTokens?: number; timeoutMs?: number } = {},
): Promise<unknown> {
  const json = await call(
    "/v1/chat/completions",
    {
      model: env.MISTRAL_CHAT_MODEL,
      messages,
      temperature: 0,
      max_tokens: opts.maxTokens ?? 900,
      response_format: { type: "json_object" },
    },
    opts.timeoutMs ?? env.RECO_TIMEOUT_MS,
  );

  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new AppError(502, "Mistral returned no content", "MISTRAL_EMPTY_RESPONSE");
  }

  try {
    return JSON.parse(content);
  } catch {
    throw new AppError(502, "Mistral returned malformed JSON", "MISTRAL_BAD_JSON");
  }
}

/** Chat completion returning prose. Used for the menu Q&A answers. */
export async function chatText(messages: ChatMessage[], maxTokens = 400): Promise<string> {
  const json = await call(
    "/v1/chat/completions",
    { model: env.MISTRAL_CHAT_MODEL, messages, temperature: 0.2, max_tokens: maxTokens },
    env.RECO_TIMEOUT_MS,
  );

  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new AppError(502, "Mistral returned no content", "MISTRAL_EMPTY_RESPONSE");
  }
  return content.trim();
}
