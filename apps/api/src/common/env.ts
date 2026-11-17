/**
 * Environment parsing with zod. Every value a feature needs is required
 * explicitly; there are no silent fallbacks. Failures are collected so the
 * operator sees the complete list instead of one-at-a-time errors.
 */
import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { createOriginPolicy, normalizeOrigin } from './origin-policy';
import { isTelegramWebhookUrl } from './telegram-webhook-url';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  APP_URL: z.string().url(),
  /** Number of proxies in front of the API (Vercel=1, none=0). Corrupts client IPs if wrong. */
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(1),
  /** Force the Swagger UI/OpenAPI document on even in production. Off by default. */
  API_DOCS_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === 'true' || value === '1'),
  // Render injects PORT; API_PORT remains the explicit local/Docker fallback.
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WORKER_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(1000).max(300000).default(30000),
  HEALTHCHECK_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(5000),
  ALLOWED_ORIGINS: z.string().min(1),
  TIMEZONE: z.string().min(3),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  REDIS_PREFIX: z.string().min(1),

  CREDENTIAL_ENCRYPTION_KEY: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  ADMIN_BOOTSTRAP_TOKEN: z.string().optional(),
  // Self-service signup is opt-in. A platform that hosts a single organisation must not expose
  // an endpoint that lets anyone on the internet mint a workspace, so the default is 'false'.
  ALLOW_SELF_REGISTRATION: bool.default('false'),

  STORAGE_DRIVER: z.enum(['local', 's3']),
  STORAGE_LOCAL_ROOT: z.string().optional(),
  STORAGE_LOCAL_PUBLIC_BASE_URL: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().url().optional(),
  ),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.optional(),
  S3_PUBLIC_BASE_URL: z.string().optional(),
  /** Legacy alias; new deployments should use S3_PUBLIC_BASE_URL. */
  STORAGE_PUBLIC_BASE_URL: z.string().optional(),

  WORK_DIR: z.string().min(1),
  // Chunk size the browser is told to use. Local-storage parts travel through the API proxy and
  // must fit its body limit. S3/R2 parts go directly to object storage and must be at least 5 MiB.
  UPLOAD_PART_SIZE_MIB: z.coerce.number().int().min(1).max(64).default(16),
  AI_ENGINE_URL: z.string().url(),
  AI_ENGINE_API_KEY: z.string().min(8),
  VIDEO_PROCESSOR_URL: z.string().url(),
  VIDEO_PROCESSOR_API_KEY: z.string().min(8),

  // ------------------------- YouTube source import -------------------------
  // Pasting a YouTube URL is a real ingest path: the pipeline downloads the original media with
  // yt-dlp, probes it with ffprobe and stores it like an upload. It is enabled by default because
  // the operator still has to accept a rights declaration per source, but it can be switched off
  // in one place for deployments that only allow their own footage.
  YOUTUBE_IMPORT_ENABLED: bool.default('true'),
  /** Absolute path or PATH-resolved binary name of yt-dlp. */
  YTDLP_PATH: z.string().trim().min(1).default('yt-dlp'),
  /** Highest downloaded rendition. 1080 keeps the vertical crop sharp without wasting bandwidth. */
  YOUTUBE_IMPORT_MAX_HEIGHT: z.coerce.number().int().min(360).max(2160).default(1080),
  YOUTUBE_IMPORT_TIMEOUT_SECONDS: z.coerce.number().int().min(60).max(7200).default(1800),
  YOUTUBE_IMPORT_MAX_FILESIZE_MB: z.coerce.number().int().min(16).max(20000).default(2048),
  /** Optional Netscape cookie file for videos that require an authenticated session. */
  YOUTUBE_COOKIES_FILE: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().optional(),
  ),
  /** Optional outbound proxy, e.g. http://user:pass@host:port. */
  YOUTUBE_PROXY: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().url().optional(),
  ),
  /** ffmpeg location handed to yt-dlp when merging separate video/audio streams. */
  YOUTUBE_YTDLP_FFMPEG_LOCATION: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().optional(),
  ),

  // ---------------------------- Firebase Auth ----------------------------
  // Legacy configuration retained for history. The active auth module does not register
  // Firebase/password controllers and these settings cannot enable alternate sign-in.
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  FIREBASE_WEB_API_KEY: z.string().optional(),
  FIREBASE_WEB_AUTH_DOMAIN: z.string().optional(),
  FIREBASE_WEB_APP_ID: z.string().optional(),
  // An identity provider proves *who* you are; it does not prove you may use this deployment.
  // Default closed: a Google account must already exist in ClipForge unless an operator opts in.
  FIREBASE_ALLOW_NEW_USERS: bool.default('false'),
  FIREBASE_REQUIRE_VERIFIED_EMAIL: bool.default('true'),

  // ---------------------------- Telegram Login ----------------------------
  // Telegram Login OIDC credentials are separate from the Bot API token below. The client id is
  // public protocol metadata; the client secret must remain in the API environment.
  TELEGRAM_LOGIN_CLIENT_ID: z.string().trim().optional().transform((value) => value || undefined),
  TELEGRAM_LOGIN_CLIENT_SECRET: z.string().trim().optional().transform((value) => value || undefined),
  TELEGRAM_LOGIN_REDIRECT_URI: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().url().optional(),
  ),
  TELEGRAM_LOGIN_ALLOW_NEW_USERS: bool.default('false'),
  TELEGRAM_BOT_ID: z.preprocess(value => typeof value === 'string' && !value.trim() ? undefined : value, z.string().trim().regex(/^[1-9]\d*$/).optional()),
  TELEGRAM_WEBHOOK_URL: z.preprocess(value => typeof value === 'string' && !value.trim() ? undefined : value, z.string().url().optional()),
  TELEGRAM_LOGIN_CHALLENGE_TTL_SECONDS: z.coerce.number().int().min(60).max(600).default(300),

  // ------------------------- Telegram notifications -------------------------
  // Optional: absent values disable outbound notifications without touching any other feature. The
  // token/secret are environment-only by design — never written to the database and never returned
  // to a browser. When webhook control is configured, token/username/secret must be present together.
  TELEGRAM_BOT_TOKEN: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  TELEGRAM_CHAT_ID: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  TELEGRAM_BOT_USERNAME: z
    .string()
    .trim()
    .optional()
    .transform((value) => {
      if (!value) return undefined;
      const normalized = value.startsWith('@') ? value.slice(1) : value;
      return normalized.length > 0 ? normalized : undefined;
    }),
  TELEGRAM_WEBHOOK_SECRET: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  TELEGRAM_API_BASE: z.string().url().default('https://api.telegram.org'),
  TELEGRAM_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),
  TELEGRAM_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(6).default(3),

  /**
   * SMTP for one-time codes and password-reset mail. All optional: with no SMTP_HOST the email
   * channel reports itself as unavailable instead of pretending to send, and `POST
   * /api/auth/security/overview` says so. StartTLS on 587 is the default because that is what every
   * free-tier relay (Brevo, Mailtrap, Gmail app passwords) supports.
   */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
  SMTP_SECURE: z
    .string()
    .optional()
    .transform((value) => value === 'true' || value === '1'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),

  /** One-time-code policy. TTL in seconds, resend cooldown, and wrong-attempt budget. */
  OTP_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(300),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(1).max(600).default(60),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  /** Optional dedicated secret for code hashing; falls back to SESSION_SECRET. */
  OTP_SECRET: z.preprocess(value => typeof value === 'string' && !value.trim() ? undefined : value, z.string().min(32).optional()),

  GEMINI_API_KEY: z.string().optional(),
  GEMINI_TEXT_MODEL: z.string().optional(),
  GEMINI_VISION_MODEL: z.string().optional(),

  YOUTUBE_DATA_API_KEY: z.string().optional(),
  YOUTUBE_CLIENT_ID: z.string().optional(),
  YOUTUBE_CLIENT_SECRET: z.string().optional(),
  YOUTUBE_REDIRECT_URI: z.string().optional(),
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_GRAPH_API_VERSION: z.string().optional(),
  META_REDIRECT_URI: z.string().optional(),

  // Unit economics. Defaults reflect published list prices for the hosted model and free
  // self-hosted compute (faster-whisper, ffmpeg). Override per deployment; changing them does not
  // rewrite history, because each UsageRecord stores the cost computed when it was written.
  PRICE_GEMINI_INPUT_PER_1K_TOKENS: z.coerce.number().min(0).default(0.0001),
  PRICE_GEMINI_OUTPUT_PER_1K_TOKENS: z.coerce.number().min(0).default(0.0004),
  PRICE_VISION_INPUT_PER_1K_TOKENS: z.coerce.number().min(0).default(0.0001),
  PRICE_VISION_OUTPUT_PER_1K_TOKENS: z.coerce.number().min(0).default(0.0004),
  PRICE_TRANSCRIPTION_PER_SECOND: z.coerce.number().min(0).default(0),
  PRICE_RENDER_PER_SECOND: z.coerce.number().min(0).default(0),
  PRICE_STORAGE_PER_GB_MONTH: z.coerce.number().min(0).default(0.023),
  PRICE_PUBLISH_CALL: z.coerce.number().min(0).default(0),

  WORKER_CONCURRENCY_AI: z.coerce.number().int().positive().default(1),
  WORKER_CONCURRENCY_RENDER: z.coerce.number().int().positive().default(1),
  WORKER_CONCURRENCY_PUBLISH: z.coerce.number().int().positive().default(1),
  JOB_LEASE_SECONDS: z.coerce.number().int().positive().default(120),
  JOB_HEARTBEAT_SECONDS: z.coerce.number().int().positive().default(20),
});

export type AppEnv = z.infer<typeof envSchema>;

let cached: AppEnv | null = null;

/** A production container's loopback address is not a managed database or Redis instance. */
export function validateProductionConnections(config: { NODE_ENV: string; DATABASE_URL: string; REDIS_URL: string }): void {
  if (config.NODE_ENV !== 'production') return;
  for (const [name, raw, schemes] of [
    ['DATABASE_URL', config.DATABASE_URL, ['postgres:', 'postgresql:']],
    ['REDIS_URL', config.REDIS_URL, ['redis:', 'rediss:']],
  ] as const) {
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error(`${name} must be a valid service URL.`); }
    if (!(schemes as readonly string[]).includes(url.protocol)) throw new Error(`${name} uses an unsupported service protocol.`);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '[::1]' || host === '[::]' || /^127\./.test(host) || host.startsWith('[::ffff:7f')) {
      throw new Error(`${name} must not point to localhost/loopback in production. Use the reachable managed service hostname.`);
    }
  }
}

export function loadEnv(): AppEnv {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid environment — fix .env before starting:\n  ${issues}`);
  }
  // Storage driver specific requirements, checked here rather than defaulted.
  const env = parsed.data;
  validateProductionConnections(env);
  const appOrigin = normalizeOrigin(env.APP_URL);
  if (!appOrigin) throw new Error('APP_URL must be an HTTP(S) origin without credentials, path, query or fragment.');
  env.APP_URL = appOrigin;
  const allowedOrigin = createOriginPolicy(env.ALLOWED_ORIGINS);
  if (!allowedOrigin(appOrigin)) throw new Error('ALLOWED_ORIGINS must include the APP_URL frontend origin.');
  try { new Intl.DateTimeFormat('en', { timeZone: env.TIMEZONE }); }
  catch { throw new Error('TIMEZONE must be a supported IANA timezone, for example Asia/Kolkata or UTC.'); }
  if (env.NODE_ENV === 'production') {
    if (!isAbsolute(env.WORK_DIR)) throw new Error('WORK_DIR must be an absolute path in production, shared at the same path by media services.');
    if (env.STORAGE_DRIVER === 'local' && env.STORAGE_LOCAL_ROOT && !isAbsolute(env.STORAGE_LOCAL_ROOT)) throw new Error('STORAGE_LOCAL_ROOT must be an absolute persistent-disk path in production.');
    if (!/^[A-Za-z0-9+/]{43}=$/.test(env.CREDENTIAL_ENCRYPTION_KEY) || Buffer.from(env.CREDENTIAL_ENCRYPTION_KEY, 'base64').length !== 32) throw new Error('CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key (openssl rand -base64 32). Preserve the existing key to decrypt existing credentials.');
  }

  if (!env.S3_PUBLIC_BASE_URL && env.STORAGE_PUBLIC_BASE_URL) {
    env.S3_PUBLIC_BASE_URL = env.STORAGE_PUBLIC_BASE_URL;
  }
  if (env.STORAGE_DRIVER === 'local' && (!env.STORAGE_LOCAL_ROOT || !env.STORAGE_LOCAL_PUBLIC_BASE_URL)) {
    throw new Error('STORAGE_DRIVER=local requires STORAGE_LOCAL_ROOT and STORAGE_LOCAL_PUBLIC_BASE_URL');
  }
  // The public web config needs only FIREBASE_PROJECT_ID, so a project id on its own is a legitimate
  // (browser-configured, verifier-missing) deployment. The credential pair must not be split.
  // Legacy OAuth settings are no longer consulted by the active authentication module.
  if (env.NODE_ENV === 'production' && new URL(env.APP_URL).protocol !== 'https:') throw new Error('Telegram-only authentication requires HTTPS APP_URL in production.');
  if (env.NODE_ENV === 'production' && (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_BOT_USERNAME || !env.TELEGRAM_WEBHOOK_SECRET)) {
    throw new Error('Telegram-only authentication requires TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME and TELEGRAM_WEBHOOK_SECRET in production.');
  }
  if (env.TELEGRAM_WEBHOOK_URL && !isTelegramWebhookUrl(env.TELEGRAM_WEBHOOK_URL)) {
    throw new Error('TELEGRAM_WEBHOOK_URL must be a public HTTPS hostname ending /api/auth/telegram/webhook, not localhost, an IP literal or a private hostname. Use an HTTPS tunnel for local development.');
  }
  if (env.TELEGRAM_BOT_ID && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_ID !== env.TELEGRAM_BOT_TOKEN.split(':')[0]) {
    throw new Error('TELEGRAM_BOT_ID must match the bot ID prefix of TELEGRAM_BOT_TOKEN.');
  }
  // Validate the Telegram configuration at boot rather than at the first failed notification:
  // a malformed token is a deploy-time mistake, and the operator should see it in the boot log.
  if (env.TELEGRAM_BOT_TOKEN && !/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(env.TELEGRAM_BOT_TOKEN)) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN is malformed: it must look like "<bot id>:<35+ character secret>" — copy it from BotFather (@BotFather → /mybots → API Token).',
    );
  }
  if (env.TELEGRAM_CHAT_ID && !/^-?\d{4,20}$/.test(env.TELEGRAM_CHAT_ID) && !/^@[A-Za-z0-9_]{5,32}$/.test(env.TELEGRAM_CHAT_ID)) {
    throw new Error('TELEGRAM_CHAT_ID is malformed: use a numeric chat id (e.g. -1001234567890) or @channelusername.');
  }
  if (env.TELEGRAM_BOT_USERNAME && !/^[A-Za-z0-9_]{5,32}$/.test(env.TELEGRAM_BOT_USERNAME)) {
    throw new Error('TELEGRAM_BOT_USERNAME is malformed: use the bot username without @ (letters, digits, underscore, 5-32 chars).');
  }
  if (env.TELEGRAM_WEBHOOK_SECRET && (env.TELEGRAM_WEBHOOK_SECRET.length < 16 || env.TELEGRAM_WEBHOOK_SECRET.length > 256 || !/^[A-Za-z0-9_-]+$/.test(env.TELEGRAM_WEBHOOK_SECRET))) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET must be 16-256 chars of letters, digits, underscore, or hyphen.');
  }
  // Outbound notifications need only the bot token. Bot commands/webhook registration also need
  // the public bot username and a secret header, so require the full trio only when webhook control
  // is being configured.
  if ((env.TELEGRAM_BOT_USERNAME || env.TELEGRAM_WEBHOOK_SECRET) &&
      (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_BOT_USERNAME || !env.TELEGRAM_WEBHOOK_SECRET)) {
    throw new Error('Telegram webhook control requires TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME, and TELEGRAM_WEBHOOK_SECRET together.');
  }
  if (env.STORAGE_DRIVER === 's3' && (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY || !env.S3_REGION)) {
    throw new Error('STORAGE_DRIVER=s3 requires S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY');
  }
  if (env.STORAGE_DRIVER === 's3' && env.UPLOAD_PART_SIZE_MIB < 5) {
    throw new Error('STORAGE_DRIVER=s3 requires UPLOAD_PART_SIZE_MIB to be at least 5 for S3 multipart uploads.');
  }
  cached = env;
  return env;
}

/** Test-only: drop the cached value so a test can exercise a different configuration. */
export function resetEnvCache(): void {
  cached = null;
}

export const env = new Proxy({} as AppEnv, {
  get: (_t, prop: string) => (loadEnv() as Record<string, unknown>)[prop],
});
