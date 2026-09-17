import { env } from "../lib/env.ts";
import type { ChatInput } from "../schemas/menu.schema.ts";
import { ask } from "./menu.ask.service.ts";
import { parseQuery } from "./menu.parse.service.ts";
import { recommend } from "./menu.recommend.service.ts";

/**
 * One door for the chat UI.
 *
 * "2 veg and 1 spicy non veg" and "what is in the biryani" are different
 * problems -- the first is a constrained multi-slot retrieval, the second is
 * grounded Q&A. Deciding between them is the backend's job, so the frontend
 * sends a message and renders whatever comes back.
 *
 * The parse runs once here and is handed to `recommend`, so the recommendation
 * path costs one LLM call rather than two.
 */
/** Opens like a question... */
const QUESTION_RE =
  /^\s*(what|which|is|are|was|were|does|do|did|can|could|how|why|where|who|when|tell me|explain)\b/i;
/** ...but these mean the guest wants suggestions, not an explanation. */
const REQUEST_RE =
  /\b(recommend|recommendation|suggest|should we (order|get|have)|order for|table for|for \d+ (people|pax|guests)|people|pax|guests)\b/i;

/**
 * The parser will happily invent a slot for any dish mentioned, so
 * "what is in the butter naan" came back as a one-slot recommendation request.
 * A question shape with no request words wins over whatever the model returned.
 */
function looksLikeQuestion(message: string): boolean {
  return QUESTION_RE.test(message) && !REQUEST_RE.test(message);
}

export async function chat(input: ChatInput) {
  const started = Date.now();
  const parsed = await parseQuery(input.message);

  // "what should we order for four" states no constraint, so the parser can come
  // back empty -- but it is plainly a request for suggestions, not a question.
  // Stand in a single unconstrained slot rather than dropping to Q&A.
  if (parsed.plan.slots.length === 0 && REQUEST_RE.test(input.message)) {
    const count = Math.max(1, Math.min(50, parsed.plan.partySize || 1));
    parsed.plan.slots.push({
      label: count > 1 ? `${count} guests` : "Something good",
      count,
      diet: "any",
      spice: "any",
      cuisine: "any",
      course: "any",
      courseGroup: "food",
      searchText: count > 1 ? "popular dish to share" : "popular dish",
    });
  }

  // Slots mean the guest stated constraints, which is a recommendation request.
  if (parsed.plan.slots.length > 0 && !looksLikeQuestion(input.message)) {
    const result = await recommend(
      {
        query: input.message,
        perSlot: input.perSlot,
        includeDrinks: input.includeDrinks,
      },
      parsed,
    );
    return { kind: "recommendations" as const, ...result };
  }

  const { answer, dishes, chips } = await ask(input.message);
  return {
    kind: "answer" as const,
    query: input.message,
    answer,
    dishes,
    chips,
    meta: {
      parseMode: parsed.mode,
      chatModel: env.MISTRAL_CHAT_MODEL,
      embedModel: env.MISTRAL_EMBED_MODEL,
      tookMs: Date.now() - started,
    },
  };
}
