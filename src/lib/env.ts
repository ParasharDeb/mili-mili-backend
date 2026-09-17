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
   * Recommendation engine (Mistral + Pinecone). Deliberately optional with
   * empty defaults: `env.ts` throws at import, so making these required would
   * stop the whole server booting on any machine that hasn't added the keys.
   * `/api/menu/recommend` returns 503 RECO_UNCONFIGURED instead.
   */
  MISTRAL_API_KEY: z.string().default(""),
  MISTRAL_BASE_URL: z.string().default("https://api.mistral.ai"),
  MISTRAL_EMBED_MODEL: z.string().default("mistral-embed"),
  MISTRAL_CHAT_MODEL: z.string().default("ministral-8b-latest"),
  /** Must match the Pinecone index the rag/ project created. */
  MISTRAL_EMBED_DIM: z.coerce.number().int().positive().default(1024),

  PINECONE_API_KEY: z.string().default(""),
  PINECONE_INDEX: z.string().default("milli-milli-menu"),
  PINECONE_NAMESPACE: z.string().default("items"),

  /** Candidates pulled per slot before dedupe and constraint re-verification. */
  RECO_CANDIDATE_TOPK: z.coerce.number().int().positive().default(25),
  RECO_MAX_SLOTS: z.coerce.number().int().positive().default(6),
  RECO_TIMEOUT_MS: z.coerce.number().int().positive().default(9000),

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

/** True when the recommendation engine has everything it needs to run. */
export const isRecoConfigured = Boolean(env.MISTRAL_API_KEY && env.PINECONE_API_KEY);
