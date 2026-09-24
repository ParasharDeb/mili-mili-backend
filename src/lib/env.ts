import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  /** Must be long enough that HS256 signatures aren't brute-forceable. */
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_EXPIRES_IN: z.string().default("7d"),

  /**
   * Mistral, for the prose paths only: the grounded Q&A answer and the advisory
   * combo. Deliberately optional with an empty default -- `env.ts` throws at
   * import, so making it required would stop the whole server booting on a
   * machine that hasn't added the key. Structured menu queries are pure SQL and
   * need no key at all.
   */
  MISTRAL_API_KEY: z.string().default(""),
  MISTRAL_BASE_URL: z.string().default("https://api.mistral.ai"),
  MISTRAL_CHAT_MODEL: z.string().default("ministral-8b-latest"),

  /**
   * Jev (TypeSafe AI) -- the System One classifier that routes every chat turn
   * and reads the constraints out of it. Optional for the same reason: without a
   * key the router falls back to the regex parser and the chat still works.
   */
  TYPESAFE_API_KEY: z.string().default(""),
  TYPESAFE_BASE_URL: z.string().default("https://api.typesafe.ai"),
  JEV_MODEL: z.string().default("jev-latest"),
  JEV_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),
  /** Below this, a `choice` answer is treated as "not stated" rather than acted on. */
  JEV_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.55),
  /**
   * Diet gets a higher bar than everything else. Widening is safe for cuisine or
   * course; for diet, acting on a shaky `veg` hides the food a guest wanted and
   * acting on a shaky `nonveg` is worse. See menu.slots.service.ts.
   */
  JEV_DIET_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.7),
  /** A noul counts as true only above this. Deliberately above 0.5. */
  JEV_NOUL_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  /** Consecutive failures before the breaker opens and the regex router takes over. */
  JEV_BREAKER_TRIPS: z.coerce.number().int().positive().default(3),
  JEV_BREAKER_COOLDOWN_MS: z.coerce.number().int().positive().default(60_000),

  /** Candidates pulled per slot before dedupe and constraint re-verification. */
  RECO_CANDIDATE_TOPK: z.coerce.number().int().positive().default(100),
  RECO_MAX_SLOTS: z.coerce.number().int().positive().default(6),
  RECO_TIMEOUT_MS: z.coerce.number().int().positive().default(9000),

  /** Max dishes rendered into the full-menu advisory prompt. */
  ADVISE_MAX_ITEMS: z.coerce.number().int().positive().default(200),

  SESSION_TTL_MINUTES: z.coerce.number().int().positive().default(120),
  SESSION_MAX: z.coerce.number().int().positive().default(5000),
  CART_MAX_LINES: z.coerce.number().int().positive().default(40),

  OTP_TTL_MINUTES: z.coerce.number().int().positive().default(5),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  /** Min seconds between two OTP requests for the same phone number. */
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(60),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment variables:\n${issues}`);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === "production";

/**
 * Recommendations are no longer a configurable feature. They are SQL against
 * Postgres, so if the server booted they work. Only the prose paths -- the
 * grounded answer and the advisory combo -- can be unconfigured.
 */
export const isChatConfigured = Boolean(env.MISTRAL_API_KEY);

/** Without this the router falls back to regex, which is a downgrade, not an outage. */
export const isJevConfigured = Boolean(env.TYPESAFE_API_KEY);
