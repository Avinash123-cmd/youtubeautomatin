# Deploying ClipForge AI

## The short answer about Vercel

**Only the dashboard (`apps/web`) can run on Vercel.** The rest of the platform physically cannot,
and it is better to know that before spending a day fighting it:

| Part | Runs on Vercel? | Why |
| --- | --- | --- |
| `apps/web` (Next.js 15 dashboard) | **Yes** | built for it |
| `apps/api` (NestJS, HTTP) | No | Vercel runs serverless functions; the API holds a Redis connection pool and long request lifecycles |
| 5 BullMQ workers (`pipeline`, `render`, `publish`, `scheduler`, `recovery`) | **No** | serverless functions do not stay alive between requests, so a queue consumer never consumes |
| `services/ai-engine` (faster-whisper + Gemini) | **No** | CPU-heavy, needs ~2 GB and long execution; function limits are memory-, time- and payload-bound |
| `services/video-processor` (FFmpeg) | **No** | FFmpeg encoding for a 30 s clip takes 10–60 s of sustained CPU |
| PostgreSQL / Redis | No | use Neon / Upstash |
| File storage | No | Vercel's filesystem is read-only and ephemeral; use Cloudflare R2 / S3 |

This is not a limitation of this codebase — it is what serverless is for. The standard split is:

```
        Browser
           │
           ▼
   ┌───────────────┐        ┌──────────────────────────────┐
   │    Vercel     │ /api/* │  Render (Docker, always-on)  │
   │  apps/web     ├───────▶│  clipforge-api   :4000       │
   │  (dashboard)  │ /media │  clipforge-workers (BullMQ)  │
   └───────────────┘        │  clipforge-ai-engine   :8100 │
                            │  clipforge-video-proc. :8200 │
                            └───────┬──────────────┬───────┘
                                    │              │
                             Neon Postgres   Upstash Redis + R2 storage
```

The browser only ever talks to the Vercel origin; Next.js rewrites `/api` and `/media` to the API.
Session cookies therefore stay **first-party** — no CORS, no token in localStorage.

---

## What is already prepared in this repo

| File | Purpose |
| --- | --- |
| `apps/web/vercel.json` | pins the framework, region `bom1` (Mumbai), and security headers |
| `apps/web/next.config.ts` | resolves the API origin for the `/api` + `/media` rewrites (build time), from `API_INTERNAL_URL` → `apps/web/api-target.json` → local default. A hosted build with neither is still produced, against an unresolvable sentinel, so the deployment succeeds and says what is missing instead of failing the build |
| `apps/web/api-target.json` | the same origin, committed to git — for anyone who would rather edit a file than a dashboard setting. **Ships empty on purpose:** it must hold *your* API's URL, never a guessed one |
| `render.yaml` | **free** backend blueprint: Render Postgres + Key Value + the API, self-contained, one click |
| `render.pipeline.yaml` | the full paid stack (workers, transcription, rendering) — rename to `render.yaml` when you need it |
| `apps/api/scripts/run-workers.sh` | runs the five worker roles in one container and restarts them as a group |
| `UPLOAD_PART_SIZE_MIB` (new env var) | chunk size the API advertises to the browser, default 16 MiB |
| `scripts/deploy-vercel.sh` | one command: validates the API origin, builds locally with it, sets the env var and deploys |
| `apps/web/app/healthz/route.ts` | **`/healthz`** on the dashboard — reports the baked-in API origin, probes it live (`ok`, upstream status, latency, region, commit) and identifies *who answered*: `identity: "clipforge"` vs `"other"` |
| `apps/web/components/backend-down.tsx` | the screen shown when the API is unreachable, with the three settings to check and a self-check button |
| `/admin` → “Dashboard → API link” | the same probe inside the app, refreshed every 30 s |

### Where the API origin comes from (in order)

| # | Source | When it applies |
| --- | --- | --- |
| 1 | `API_INTERNAL_URL` environment variable | set in Vercel → Settings → Environment Variables (Production, Preview, Development) |
| 2 | `apps/web/api-target.json` → `{ "apiOrigin": "https://…" }` | committed to git; Vercel rebuilds on push. Use this if the dashboard UI is a pain |
| 3 | `http://127.0.0.1:4000` | local `next dev` / `next build` only |

A value pasted with a trailing slash or a `/api` suffix is normalised (that mistake would otherwise
rewrite to `/api/api/…`). A hosted build with no origin at all is still produced — against
`https://api-not-configured.invalid` — so the deploy succeeds, every call fails fast, and the UI says
so. Changing the origin always needs a **redeploy**, because it is compiled into the rewrites.

### "It answered, but it is not your API"

A live URL that is not yours is the most misleading failure: the fetch succeeds, so nothing looks
*down*, and every route returns `404`. Render service names are **global** — if `clipforge-api` is
already taken, Render names yours `clipforge-api-xxxx.onrender.com` and your dashboard keeps talking
to the stranger.

`/healthz` now separates the two:

| `identity` | `upstream.status` | means |
| --- | --- | --- |
| `clipforge` | 200 | correct origin, correct API |
| `other` | 404 | that host is not ClipForge — copy the URL from **your** Render service page |
| `unknown` | `null` | nothing answered (wrong host, or a free instance waking up — allow ~30 s) |

Check the body, not only the status:

```bash
curl -s https://<your-api-host>/api/system/health
# {"status":"ok","uptimeSeconds":…,"version":"1.0.0","checks":[{"component":"postgres",…}]}
```

Anything else — a different JSON shape, an HTML page, `Cannot GET` — is somebody else's service.

---

## Step 1 — managed database and queue (10 min)

1. **Neon** (https://neon.tech) → create a project → copy the connection string, add
   `?sslmode=require`. This becomes `DATABASE_URL`.
2. **Upstash** (https://console.upstash.com) → create a Redis database → copy the `rediss://` URL.
   This becomes `REDIS_URL`.
3. **Cloudflare R2** (https://dash.cloudflare.com → R2) → create a bucket, an API token with
   object read/write, and note the S3 endpoint. Optional but required for Instagram publishing,
   which needs a public HTTPS URL for the video.

Run the migrations against Neon once, from your machine:

```bash
cd clipforge-ai
DATABASE_URL='postgresql://…neon…?sslmode=require' npm run db:deploy
```

## Step 2 — backend on Render (10 min, one account, $0)

The repository's default `render.yaml` is self-contained: it creates the Postgres database, the
Redis (Key Value) instance **and** the API, wired to each other. There is nothing to paste and no
Neon/Upstash/R2 sign-up.

1. Open **https://dashboard.render.com** → **New → Blueprint**.
2. Pick the `youtube_automation` repository → **Apply**.
   Render creates `clipforge-db`, `clipforge-redis` and `clipforge-api`.
3. Wait for `clipforge-api` to turn **Live** (first build ≈ 5–8 min; it applies the Prisma
   migrations on start). Copy its URL — normally `https://clipforge-api.onrender.com`.
4. Check it answers:
   ```bash
   curl -s https://clipforge-api.onrender.com/api/system/health
   ```
   Free instances sleep after 15 minutes, so the very first call can take ~30 s. A `200` after that
   is what you want.

**Point the dashboard at it (one line, no Vercel settings needed):**

5. On GitHub open `apps/web/api-target.json` → pencil → set
   ```json
   { "apiOrigin": "https://clipforge-api.onrender.com" }
   ```
   → **Commit changes**. Vercel rebuilds automatically. (Already prefilled with that URL — edit only
   if Render gave your service a different name. `API_INTERNAL_URL` in Vercel, if you ever set it,
   wins over this file.)
6. Open `https://<your-app>.vercel.app/healthz` → `ok:true`, `upstream.status: 200`.

### First sign-in

1. Open the dashboard → **First-run setup**.
2. On Render open `clipforge-api` → **Environment** → copy `ADMIN_BOOTSTRAP_TOKEN`.
3. Paste it with your email / password / workspace name → **Create administrator**.
4. You are in. `/admin` shows what is and is not running: on this free stack the API, Postgres and
   Redis are healthy and the pipeline services are honestly reported as down.

### When you want the actual video pipeline

`render.pipeline.yaml` is the full stack: the five BullMQ workers, the faster-whisper transcription
service and the FFmpeg renderer. It needs paid instance types (workers do not exist on Render's free
plan) plus Neon/Upstash/R2. Rename that file to `render.yaml`, point a new Blueprint at the repo, and
follow the `sync: false` prompts. Until then uploads sit at `QUEUED` — the API does not fake progress.

## Step 3 — dashboard on Vercel (5 min)

### Option A — one command

```bash
cd clipforge-ai
./scripts/deploy-vercel.sh https://clipforge-api.onrender.com          # preflight, build, then print the steps
./scripts/deploy-vercel.sh https://clipforge-api.onrender.com --deploy # same, then `vercel --prod`
```

It refuses a localhost/`http` origin, refuses a dead API (it curls `/api/system/health` first), runs
a real `next build` with that origin before spending a deploy, and finally prints the two API-side
variables you still have to set. Without the Vercel CLI it prints the dashboard clicks below instead.

### Option B — Vercel dashboard (no CLI)

1. https://vercel.com/new → import the same repository.
2. **Root Directory: `apps/web`** ← the one setting people get wrong. Vercel then detects Next.js
   and installs from the repository root automatically.
3. **Environment Variables** (Production *and* Preview *and* Development):

   | Name | Value | When it is read |
   | --- | --- | --- |
   | `API_INTERNAL_URL` | `https://clipforge-api.onrender.com` | **build time** — baked into the `/api` and `/media` rewrites |
   | `UPLOAD_CSP_ORIGINS` | `https://objects.example.net` | **build time**, only for a custom S3-compatible endpoint; AWS S3/R2 hosts are already allowed |
   | `NEXT_PUBLIC_APP_NAME` | `ClipForge AI` (optional) | build + runtime |

   Firebase needs **nothing** on Vercel: the login page asks the API for the public web config at
   runtime (`GET /api/auth/providers`). Put the `FIREBASE_*` service-account values on the API
   instead — `docs/FIREBASE-AUTH.md` steps 5–9.
   Configure the bucket's browser CORS rules for `PUT` and exposed `ETag` as described in
   `docs/UPLOADS.md`.

4. Deploy. If `API_INTERNAL_URL` is missing the build still **succeeds**, but the log prints a
   deployment notice and the app then shows “This dashboard cannot reach its API” with `/healthz`
   naming the setting. Nothing is ever shipped silently pointing at `127.0.0.1`.
5. Copy the deployment URL (e.g. `https://youtube-automation.vercel.app`) and put it into the Render
   API service as `APP_URL` **and** `ALLOWED_ORIGINS`, then redeploy the API. Until you do, the API
   rejects the dashboard's `Origin` header (CSRF/origin checks are strict by design).
6. Open `https://<your-app>.vercel.app/healthz`. `ok:true` with `upstream.status 200` means the
   proxy works; `ok:false` names the origin it tried, so the fix is one env var, not a hunt.

## Step 4 — first run

1. Open the Vercel URL → the app asks for the bootstrap token.
2. On Render, read `ADMIN_BOOTSTRAP_TOKEN` from the API service's environment (it was generated).
3. Create the admin account, then go to **Configuration** and fill the workspace settings
   (the setup screen lists every missing key; nothing is silently defaulted).
4. Upload a short MP4, wait for the pipeline, download the vertical clip.

## Step 5 — verification checklist

```bash
curl -s https://clipforge-api.onrender.com/api/system/health      # status ok, postgres + redis healthy
curl -s https://clipforge-api.onrender.com/api/system/readiness   # every dependency + worker roles
curl -sI https://<your-app>.vercel.app/                           # 200, security headers present
```

In the dashboard: login works, **System** shows five live workers, an upload reaches `COMPLETED`
with 2 clips, the clip downloads over `/media/…` (Range requests supported).

---

## When the dashboard is live but nothing works

The dashboard now diagnoses this instead of logging you out. Three places say the same thing:

| Where | What it tells you |
| --- | --- |
| `https://<app>.vercel.app/healthz` | the API origin baked into the build, whether it answered, how fast, and the Vercel region/commit |
| the login page / any page | “This dashboard cannot reach its API” with the failed response and a **Run self-check** button — never a login form that cannot succeed |
| `/admin` → “Dashboard → API link” | the same probe for operators, refreshed every 30 s |

| Symptom | Cause | Fix |
| --- | --- | --- |
| `/healthz` → `ok:false`, `upstream.error: "fetch failed"` | API down, or `API_INTERNAL_URL` wrong/typo'd | start the API; correct the env var **and redeploy** (it is read at build time) |
| `/healthz` → 200, but sign-in returns 403 `CSRF_FAILED` | `APP_URL` / `ALLOWED_ORIGINS` on the API do not match the Vercel domain | set both to the exact Vercel origin, restart the API |
| `/healthz` → 200, sign-in 401 for a correct password | API was bootstrapped with different data, or login rate-limit (10 per 300 s) | check the API logs; wait out the limiter |
| build log prints “⚠ ClipForge deployment notice — No usable API origin” | neither `API_INTERNAL_URL` nor `api-target.json` gave an origin (or the value was `localhost`/not a URL) | set it, then redeploy: **A** Settings → Environment Variables → `API_INTERNAL_URL` (Production + Preview + Development), or **B** commit `apps/web/api-target.json` → `{ "apiOrigin": "https://your-api-host" }`. The origin is frozen into the rewrites at build time, so a redeploy is always required |
| build succeeded but every page says “cannot reach its API” | the variable points at a host that is not running (a placeholder, or the API is asleep) | open `https://<app>/healthz` — it names the origin and the failure; fix the variable and redeploy |
| images/video break but the UI is fine | `/media` rewrite target wrong, or `STORAGE_DRIVER=local` on the API | use `STORAGE_DRIVER=s3` + `S3_PUBLIC_BASE_URL` on a hosted API |

## Gotchas that bite in production

| Issue | What happens | Fix |
| --- | --- | --- |
| Vercel function payload cap (4.5 MB) | `413 FUNCTION_PAYLOAD_TOO_LARGE` on upload parts | the proxy here is a routing-level rewrite, not a function; if you add middleware that touches `/api`, bodies get buffered by a function. A smaller `UPLOAD_PART_SIZE_MIB` only applies to `STORAGE_DRIVER=local`; S3/R2 parts upload directly to storage and must stay at least 5 MiB. |
| `API_INTERNAL_URL` changed | rewrites are baked at build time | change the env var **and** redeploy the Vercel project |
| Wrong `Origin` | `403 CSRF_FAILED` on every POST | `APP_URL`/`ALLOWED_ORIGINS` on Render must equal the Vercel URL exactly (scheme + host, no trailing slash) |
| Local storage on a hosted API | uploads vanish on the next deploy | `STORAGE_DRIVER=s3` |
| `WORK_DIR` on a container | `/app/...` is ephemeral and may be read-only | point it at `/tmp/clipforge/...` (already set in `render.yaml`) |
| Instagram publishing | Meta cannot fetch `http://…` | set `S3_PUBLIC_BASE_URL` to a public HTTPS bucket domain |
| Vercel Hobby plan | non-commercial use only | upgrade to Pro for a commercial deployment |

## If you want everything on one platform instead

Vercel can be skipped entirely: `docker-compose.prod.yml` already defines the web container behind
Caddy (TLS, HTTP/3) plus API, workers, both Python services, Postgres and Redis. One VPS with Docker
runs the whole thing, with no cold starts and no payload caps. The only thing you give up is
Vercel's preview deployments.

## Native Node backend on Render — workspace build repair (2026-11-16)

This applies to a manually created **Node Web Service**, not the Docker blueprint above.

### Why the reported build failed

The log from commit `140a2abb793905524392cbf6fc7c1710fd317f78` shows `npm run build`
executing in `apps/api`. Its prebuild only built validation (and shared-types), not the API's
other runtime workspace packages. Both `@clipforge/database` and `@clipforge/platform-connectors`
resolve through ignored `dist/index.js` / `dist/index.d.ts`, which do not exist in a fresh checkout.
The schema-specific Prisma client also was not generated: the missing Otp enums and SourceVideo
Prisma types are evidence of that separate generation step being omitted. Most implicit-any and
unknown/property errors are downstream of these missing dependencies, not a reason to weaken
TypeScript or patch dozens of application methods.

API predev/prebuild/pretypecheck now run validation → platform-connectors → database; validation
builds shared-types first and database runs `prisma generate` using its own schema before tsc.
Root `build:api` / `start:api` commands provide backend-only Render entry points. No DB migrations,
resets, secrets, auth logic or video pipeline code were changed by this repair.

### Exact Render service settings

Use the **repository root**, so all workspaces and the root lockfile are included:

| Setting | Value |
| --- | --- |
| Runtime | Node |
| Root Directory | **Leave blank** (repository root) |
| Build Command | `npm ci --include=dev && npm run build:api` |
| Start Command | `npm run start:api` |
| Health Check Path | `/api/system/health` |
| Environment | `NODE_ENV=production` |
| Node version | Pin `NODE_VERSION=22.22.3` (the local verification version), instead of relying on Render's default |

Do not set Root Directory to `apps/api`: Render must retain access to sibling `packages/`.
If intentionally invoking a command within that directory in a full monorepo checkout, `npm run
build` there is now dependency-complete too. Do not use `--ignore-scripts` for the build or omit
build-time dev dependencies. Do not copy the sandbox's Prisma engine-free flags to Render: normal
`prisma generate` must download/include a native engine for the deployment platform. No need to
build the Next frontend on the backend service.

Set runtime environment values securely in Render, using `.env.example` as the inventory:

- `DATABASE_URL`: actual PostgreSQL connection string; `REDIS_URL`: reachable Redis/Key Value URL;
  `REDIS_PREFIX=clipforge`.
- `APP_URL` and `ALLOWED_ORIGINS`: the actual frontend HTTPS origin(s); no wildcard.
- `SESSION_SECRET`: at least 32 random characters; `CREDENTIAL_ENCRYPTION_KEY`: valid encryption key
  per the environment inventory. Preserve existing production values to retain sessions/decryption.
- `TIMEZONE=Asia/Kolkata`, `LOG_LEVEL=info`.
- Storage configuration and `WORK_DIR` (e.g. `/tmp/clipforge/work`). Local storage is ephemeral on
  Render; use configured S3-compatible storage for durable production media.
- Required `AI_ENGINE_URL`, `AI_ENGINE_API_KEY`, `VIDEO_PROCESSOR_URL`, `VIDEO_PROCESSOR_API_KEY`.
  Actual video processing additionally needs the separate services/workers; deploying only the API
  does not provide a functioning processing pipeline.
- Telegram-only login needs `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`,
  `TELEGRAM_WEBHOOK_SECRET` together. `TELEGRAM_WEBHOOK_URL` must use the actual public Render HTTPS
  hostname and `/api/auth/telegram/webhook`. Follow the [existing bot setup](existing-telegram-bot-setup.md);
  never register localhost or paste secrets into logs/chat.

Apply reviewed pending migrations against the existing database with `npm run db:deploy` from
the root in a controlled deploy step (Render pre-deploy command where available, otherwise an
operator-controlled environment with the same DB credentials and Prisma CLI installed). This is
`prisma migrate deploy`, **not** `migrate dev`, `db push`, or reset. Back up existing production
data first. The native Node start command does not apply migrations automatically; the Docker
entrypoint's RUN_MIGRATIONS behavior does not apply to this setup.

After the change reaches the deployed branch, use **Clear build cache & deploy** once. Check
build output for schema generation and all four workspace builds, then the Nest compilation. Check
health and `/api/auth/providers`, `/api/auth/telegram/status` on the deployed API; verify real login
only after webhook/database/session configuration. Point frontend `API_INTERNAL_URL` at this API's
actual origin and rebuild the frontend because its rewrites are compiled at build time.

### Checks and limits for this repair

- Removed generated workspace dist folders, API dist and generated Prisma client, then ran
  `npm run build:api`: dependency order, client generation and strict API compilation passed using
  engine-free generation **only in this sandbox**.
- API-local `npm run build` and API typecheck passed with the same sandbox generation flags.
- Real-entry regression checks load all four built backend packages and generated Prisma OTP enums
  and SourceVideo model metadata, without Vitest's source aliases.
- Full unit suite: **324 passed, 2 optional proxy cases skipped**, 40 files, with a test-only session
  secret. No live Telegram authentication or database operation was fabricated.
- Normal native generation was attempted but blocked by this sandbox's restricted network/TLS to
  `binaries.prisma.sh`. Native-engine download, Node 24 behavior, live Render boot, migrations and
  live authentication are **not verified** here. The Node 22 pin avoids an untested default upgrade;
  the supplied log's compile failures are dependency/generation failures, not proven Node 24 bugs.
- The audit warnings in the deployment log are separate security work, not the cause of these
  TS2307 errors. Do not run `npm audit fix --force` blindly as part of this deployment repair.

For the current compiled-only native startup, PORT precedence, Node pin and deployment evidence,
see [Render API production startup](render-api-production.md). Never use `npm run dev` as a Render Start Command.
