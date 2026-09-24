import {
  APIError,
  TypeSafeClient,
  choice,
  noul,
  score,
  type ChoiceResponse,
  type NoulResponse,
  type Questions,
  type ScoreResponse,
  type SystemOneResult,
} from "@typesafe-ai/sdk";
import { env, isJevConfigured } from "./env.ts";

/**
 * Jev (TypeSafe AI) -- the System One classifier that routes every chat turn.
 *
 * Jev is not a text generator. It answers a fixed set of typed questions about
 * some state: `choice` picks a label, `score` places the state on an ordered
 * rubric, `noul` returns a probability. That is exactly the shape of the work
 * this backend was doing with a Mistral JSON call plus a validator plus four
 * alias tables, and it removes the class of bug where a model invents an enum
 * value nobody asked for.
 *
 * Unlike lib/mistral.ts, this uses the vendor SDK. The comment there explains
 * why it does not -- the Mistral SDK pins zod v3 against this backend's zod v4.
 * `@typesafe-ai/sdk` has no runtime dependencies at all, and its generics infer
 * each answer's type from the question literals, which is most of the value of
 * using a typed classifier in the first place.
 */

export { choice, noul, score };

/**
 * Questions are evaluated in parallel and in isolation server-side, and the
 * state is billed once per request, so the marginal cost of an extra question is
 * close to nothing. Ask everything about a turn in one call.
 */
export type JevAnswers<Q extends Questions> = SystemOneResult<Q>["answers"];

let client: TypeSafeClient | null = null;

function getClient(): TypeSafeClient {
  if (!client) {
    client = new TypeSafeClient({
      apiKey: env.TYPESAFE_API_KEY,
      // Not a constant: TypeSafe exposes more than one endpoint and the keys are
      // not interchangeable, so which one an account gets is not knowable here.
      baseURL: env.TYPESAFE_BASE_URL,
      defaultModel: env.JEV_MODEL,
      timeout: env.JEV_TIMEOUT_MS,
      logLevel: "warn",
    });
  }
  return client;
}

/**
 * Circuit breaker.
 *
 * Without it, an endpoint that is down adds JEV_TIMEOUT_MS plus two SDK retries
 * to every single message before falling back. Pinned to `globalThis` for the
 * same reason the Prisma client is: `bun run --hot` re-imports modules on every
 * save and would otherwise reset the breaker constantly.
 */
type BreakerState = { failures: number; openUntil: number };
const globalForJev = globalThis as unknown as { __jevBreaker?: BreakerState };
const breaker: BreakerState = (globalForJev.__jevBreaker ??= { failures: 0, openUntil: 0 });

export function isJevAvailable(): boolean {
  return isJevConfigured && Date.now() >= breaker.openUntil;
}

function recordFailure(err: unknown): void {
  // A bad key or a malformed request will not fix itself by being retried on the
  // next message, so open the breaker immediately rather than after N turns.
  const fatal =
    err instanceof APIError && (err.status === 401 || err.status === 403 || err.status === 400);

  breaker.failures += 1;
  if (fatal || breaker.failures >= env.JEV_BREAKER_TRIPS) {
    breaker.openUntil = Date.now() + env.JEV_BREAKER_COOLDOWN_MS;
    console.warn(
      `[jev] circuit open for ${env.JEV_BREAKER_COOLDOWN_MS}ms after ` +
        `${breaker.failures} failure(s): ${err instanceof Error ? err.message : err}`,
    );
  }
}

function recordSuccess(): void {
  breaker.failures = 0;
  breaker.openUntil = 0;
}

/**
 * Asks Jev, or returns null so the caller can fall back.
 *
 * Never throws. A classifier is an optimisation over the regex parser, not a
 * dependency: if it is unconfigured, rate limited, slow or wrong-shaped, the
 * chat has to keep working.
 */
export async function askJev<const Q extends Questions>(
  state: unknown,
  questions: Q,
): Promise<JevAnswers<Q> | null> {
  if (!isJevAvailable()) return null;

  try {
    const result = await getClient().systemOne({ state: state as never, questions });
    recordSuccess();
    return result.answers;
  } catch (err) {
    recordFailure(err);
    return null;
  }
}

/* --------------------------------------------------------- answer helpers -- */

/**
 * A `choice` below the confidence floor did not happen.
 *
 * Every caller must go through this rather than reading `.choice` directly, so
 * "the model picked something, weakly" can never be mistaken for "the guest said
 * so". `min` is raised for diet at the call site.
 */
export function decided<K extends string>(
  answer: ChoiceResponse | undefined,
  fallback: K,
  min: number = env.JEV_MIN_CONFIDENCE,
): K {
  if (!answer || answer.confidence < min) return fallback;
  return (answer.choice as K) ?? fallback;
}

/**
 * A `noul` is a probability with no confidence field of its own -- distance
 * from 0.5 is the only signal there is. The threshold sits above 0.5 on purpose:
 * a coin-flip should read as "no".
 */
export function isTrue(
  answer: NoulResponse | undefined,
  threshold: number = env.JEV_NOUL_THRESHOLD,
): boolean {
  return (answer?.noul ?? 0) >= threshold;
}

/**
 * Rounds a `score` to a rubric level, or null when it is too weak to act on.
 *
 * The score is a weighted mean and may land between levels, which is useful for
 * ordering but not for picking a band -- so round, and let the caller decide
 * what a null means.
 */
export function level(
  answer: ScoreResponse | undefined,
  min: number = env.JEV_MIN_CONFIDENCE,
): number | null {
  if (!answer || answer.confidence < min) return null;
  return Math.round(answer.score);
}
