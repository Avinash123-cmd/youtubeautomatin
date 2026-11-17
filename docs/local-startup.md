# Reliable local API and frontend startup

## Start from the existing Windows checkout

This guide applies to `C:\projects\youtube_automation-master`. The repair was made in the sandbox clone, not by accessing that Windows directory. Pull the repaired revision before following it. Preserve your existing database, encryption key, session secret and root `.env`.

1. Install dependencies once from the repository root using `npm ci`. The API npm hooks build all workspace dependencies and generate Prisma's client; they require normal Prisma engine download access.
2. Configure the existing root `.env` with the real PostgreSQL/Redis and required service settings from `.env.example`. Keep `API_PORT=4000` if that is your existing setting. For a local browser use `APP_URL=http://localhost:3000` and explicitly include that origin in `ALLOWED_ORIGINS`. Do not use a wildcard.
3. Inspect port ownership **without killing anything**:

   ```powershell
   Set-Location C:\projects\youtube_automation-master
   Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue |
     Select-Object LocalAddress, LocalPort, OwningProcess
   # Substitute the actual PID returned above, not every node.exe process:
   Get-CimInstance Win32_Process -Filter "ProcessId = 12345" |
     Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine
   ```

   If it is an API workflow you recognize, use Ctrl+C in its owning terminal. If a service manager owns it, stop that specific known service through the manager. If it is unrelated, leave it alone and decide explicitly which port/service to use. Do not run taskkill against all Node processes. The repair never selects another port or terminates a foreign listener.
4. In **terminal A**, run exactly one API workflow:

   ```powershell
   npm run dev:api
   ```

   Do not also run `npm run start:api`, `node apps/api/dist/main.js`, another `dev:api`, an IDE launch configuration or a Docker API mapped to port 4000. `dev:api` already compiles and starts the API; do not launch Nest manually after compilation. Workers have separate entry points and do not start an HTTP API.

   Wait for **ClipForge API listening** after `listen()` succeeds. Nest's **application successfully started** line describes initialization, not proof of a successful port bind. EADDRINUSE is fatal and now reports the port and instructions; the watcher exits instead of leaving a compiler-only workflow looking alive.
5. Verify the real backend, not merely an open TCP port:

   ```powershell
   Invoke-RestMethod http://127.0.0.1:4000/api/system/live
   Invoke-RestMethod http://127.0.0.1:4000/api/system/health
   Invoke-RestMethod http://127.0.0.1:4000/api/auth/session
   ```

   Liveness returns `status=ok, service=clipforge-api`. Readiness checks PostgreSQL/Redis and correctly returns 503 if they are unavailable. A cookie-free session request should return authenticated=false, not create a session. Do not use a mock database or fake authentication to turn these checks green.
6. In **terminal B**, set the frontend proxy origin for this shell and start only Next:

   ```powershell
   $env:API_INTERNAL_URL = 'http://127.0.0.1:4000'
   npm run dev:web
   ```

   Match the explicit origin to the API's actual API_PORT. This preserves the default port; it does not override the backend environment. Next's root `.env` loading differs from Nest's: use this shell variable or a private `apps/web/.env.local`, not an assumption that Next reads the repository-root `.env`.

   The proxy target precedence remains API_INTERNAL_URL, then apps/web/api-target.json, then the local default. No committed production URL was changed. Next now probes real `/api/system/health` on startup and warns if readiness fails without spawning another backend. Browser requests remain same-origin `/api/...`; localhost is used only by the server-side proxy.
7. Verify through Next:

   ```powershell
   Invoke-RestMethod http://localhost:3000/api/system/live
   Invoke-RestMethod http://localhost:3000/api/auth/session
   Invoke-RestMethod http://localhost:3000/healthz
   ```

   `/healthz` includes the actual compiled proxy target and probes real readiness, not a hardcoded successful state. If the API is stopped it returns 503 with local startup guidance. The page displays a backend-unavailable error and retries the failed session query every five seconds; healthy sessions are not continuously polled. Login also has an explicit Retry connection action.
8. Stop terminal A with Ctrl+C. Confirm `/healthz` becomes 503 and the UI offers a useful error/retry. Restart **only terminal A**; the same frontend should recover on retry without changing ports. Stop terminal B with Ctrl+C when finished.

Changing API_INTERNAL_URL requires restarting Next dev. Production rewrites are build-time settings and require a frontend rebuild. Do not change hosted URLs to localhost to fix local startup.

## Lifecycle repair and exact diagnosis

EADDRINUSE proves a listener conflict at the instant of bind; it does not identify the listener. ECONNREFUSED proves no listener accepted the later frontend connection at that target. These observations may occur at different times. The original Windows process tree is not available here, so the exact conflicting PID/launch source cannot be stated as fact.

Repository findings: the old watcher killed/restarted on compiler success, tracked API termination with `exit` rather than `close`, had no bounded child shutdown or Windows graceful IPC path, and left the compiler running after an unexpected API exit. It could conceal a failed backend and made ownership/restart behavior fragile. It did not by itself prove that it caused the reported duplicate. Next starts only Next; workers do not import/bootstrap main. No duplicate endpoint/server module was added.

The repaired watcher serializes restart requests until the old child closes, coalesces repeated compile messages, exits nonzero on unexpected API failure, and sends IPC shutdown on Windows and Unix. Nest closes its HTTP and module resources before exiting; shutdown is idempotent. If a child exceeds the deadline, only that exact owned child is force-terminated. Compiler failures never start a new child. The standalone main module is guarded against accidental HTTP startup on import. Nest closes initialized resources on a failed listen and retains EADDRINUSE as a fatal error. Database/Redis/queue cleanup uses the existing lifecycle hooks.

## Verification — 2026-11-16

- API and frontend TypeScript checks and ESLint passed; API compilation and production Next build passed.
- Watcher tests cover repeated compile events, close-before-restart, fatal child exit, and owned-child graceful/timeout shutdown. Next startup health tests cover actual target probing and warning on failure; unavailable UI rendering is covered.
- Full unit suite: **331 passed, 3 opt-in proxy cases skipped**, 42 files (test-only SESSION_SECRET).
- Dedicated real Next proxy suite: **19 passed**, including live/session probes on port 4000, stop → healthz503/local guidance + failed session proxy → rebind4000 → healthz200/session200. Nest controllers were real but service dependencies were isolated test doubles. A separate occupied-port test verifies EADDRINUSE rejection leaves the existing listener running.
- No production database/Redis or real Telegram credentials are configured in this sandbox. Full AppModule startup, real authenticated sessions, Windows OS signal behavior and an interactive browser recovery cycle are **not verified**. Prisma engine-free generation was used for compilation only because native engine download is unavailable here. No DB reset/migration, root .env edit, credential disclosure or foreign-process termination occurred.
