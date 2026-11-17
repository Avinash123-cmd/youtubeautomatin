# Render TypeScript compiler consistency — 2026-11-16

**Current pin: TypeScript 5.9.3.** The original 5.7.2 audit below is historical; see the
[5.9.3 follow-up](#follow-up-explicit-typescript-593-pin) for the current change and verification.

## Diagnosis and version evidence

The shared base configuration sets `module: CommonJS` and `moduleResolution: Node`. `Node` is the
legacy alias TypeScript reports internally as **Node10**; it does not mean the application runs on
Node.js 10. Node.js 22 and the TypeScript module resolver are separate concerns.

TS5108 reporting that this option has been removed indicates a compiler/configuration incompatibility.
However, **this revision already pinned TypeScript 5.7.2** in the root and every workspace that declared
it; the committed lockfile contained just one installed compiler record, node_modules/typescript
version 5.7.2. Shared-types relied on the hoisted root compiler without declaring its own dependency.
A fresh `npm install` here resolved 5.7.2 everywhere. That compiler accepts the existing settings;
no TS5108 occurred. The exact compiler Render invoked cannot be recovered from the supplied log,
so a specific accidental upgrade or cache cause is not asserted as fact. Possible causes include a
different deployed manifest/lockfile, stale installation or an external compiler invocation; inspect
the new build diagnostic and deployed revision rather than assuming one.

**Before:** committed, locked and installed compiler = 5.7.2. **After:** 5.7.2, now enforced across
all workspaces. There was no repository downgrade to perform. Keeping the existing tested version
is safer than introducing a compiler upgrade or changing resolution modes to accommodate an unknown
compiler. This is compatible with the Node 22.22.3 verification environment.

## Complete configuration audit

| File | Inheritance / effective behavior |
| --- | --- |
| tsconfig.base.json | ES2022 target, CommonJS module, Node/Node10 resolution; strict checks, declaration output, decorator metadata |
| tsconfig.json | Extends base; empty include, root coordination only |
| apps/api/tsconfig.json | Extends base; src → dist, Node types, existing baseUrl; CommonJS/Node10 |
| packages/shared-types/tsconfig.json | Extends base; src → dist; CommonJS/Node10 |
| packages/validation/tsconfig.json | Extends base; src → dist; CommonJS/Node10 |
| packages/platform-connectors/tsconfig.json | Extends base; src → dist; CommonJS/Node10 |
| packages/database/tsconfig.json | Extends base; src → dist; CommonJS/Node10 |
| apps/web/tsconfig.json | Independent Next config; ESNext modules, Bundler resolution, noEmit |

All tracked tsconfigs were inspected. No tsconfig was changed, no suppress-deprecation flag was
added, and no blind NodeNext/Bundler conversion was applied. The frontend's existing Bundler mode
remains distinct from the CommonJS backend/packages.

All six workspaces now declare exact `typescript: 5.7.2`. npm ls showed a single hoisted/deduplicated
compiler, also satisfying the installed Next ESLint tooling's TypeScript peer ranges. Prisma remains
6.2.1. No application logic, authentication, database schema or production start script changed.

## Repair files

- Root package.json: exact existing pin retained; `overrides.typescript: $typescript` forces transitive
  compiler resolution to that pin. Added check:typescript and root prebuild/prebuild:api checks.
- packages/shared-types/package.json: explicit 5.7.2 devDependency instead of implicitly relying
  on the root hoist. Both root full-build and backend-only deployment commands run the guard.
- package-lock.json: regenerated through npm install; shared-types declaration synchronized. The
  existing compiler tarball/version/integrity remained unchanged.
- scripts/check-typescript.cjs: fail before compilation on non-exact pins, conflicting lockfile
  records, workspace declaration drift or a different installed runtime compiler. Prints actual
  compiler versions per workspace and actionable clean-install guidance; never installs tools.
- tests/unit/typescript-toolchain.test.ts: real workspace resolution and isolated installed/locked/
  manifest drift regression coverage.
- scripts/README.md, this document and docs/DOCUMENT-INDEX.md: usage and evidence.

The check intentionally requires installed build-time dev dependencies. Run installs/builds from
the repository root; do not install typescript@latest, regenerate a workspace-local lockfile or rely
on a globally installed tsc.

## Exact commands and results

Executed from repository root on Node 22.22.3 / npm 10.9.8:

1. `npm install` — passed on the initial manifests. `node -e "console.log(require('typescript').version)"`
   returned 5.7.2; `npm ls typescript --all` showed the same deduplicated compiler.
2. `npm run build` — package TypeScript compilation proceeded without TS5108; the normal Prisma
   native engine download failed because this sandbox cannot reach binaries.prisma.sh. This was
   **not** a successful native production build.
3. After the repair, `npm install` — passed and updated the root lockfile consistently.
4. `npm run check:typescript` and `npm ls typescript --all` — passed, all seven locations (root plus
   six workspaces) use 5.7.2.
5. Full root build, using **sandbox-only** engine-free generation:

   ```sh
   PRISMA_GENERATE_NO_ENGINE=1 \
   PRISMA_QUERY_ENGINE_LIBRARY=/bin/true \
   PRISMA_QUERY_ENGINE_BINARY=/bin/true \
   PRISMA_SCHEMA_ENGINE_BINARY=/bin/true \
   npm run build
   ```

   **Exit 0:** shared-types, validation, platform-connectors, database with Prisma client generation,
   API TypeScript compilation, and Next production build all passed. No TS5108 errors. These flags
   are a compilation workaround for this sandbox only, not production configuration or evidence
   of a working native database engine. Do not set them on Render.
6. `SESSION_SECRET=isolated-unit-test-secret-not-for-production-12345 npx vitest run --config tests/vitest.config.ts`
   — **344 passed, 3 opt-in proxy cases skipped, 45 files**. Session secret is isolated test data, not
   a root .env change or a production secret.
7. `npm run lint` — passed. TypeScript's configuration API confirmed the effective module/resolver
   values in the table. Compiled apps/api/dist/main.js exists. API start:prod remains exactly
   `node dist/main.js`; root start:api still delegates to API start:prod.

The complete compilation build passed with the explicit sandbox qualification above. Native Prisma
engine generation, a live DB connection and an actual Render deployment remain unverified here.
The install also reported dependency audit findings; those are not TS5108 causes and no blind
npm audit fix --force was run.

## Exact Render settings

After merging, use the existing native Node service and preserve existing runtime configuration:

| Setting | Value |
| --- | --- |
| Root Directory | Blank — repository root |
| Node version | NODE_VERSION=22.22.3 (also pinned by .node-version) |
| NODE_ENV | production |
| Build Command | `npm ci --include=dev && npm run build:api` |
| Start Command | `npm run start:api` |
| Health Check Path | `/api/system/health` |
| Pre-deploy where supported | `npm run db:deploy` for reviewed pending migrations against the correct existing DB |

The root production command delegates to **`npm run start:prod`** in the API workspace, which runs
compiled JavaScript with no compiler/watch process. If intentionally retaining an API-local command
in a full checkout, the API-local Start Command is `npm run start:prod`; do not run that bare command
at repository root where it is not defined. Repository-root settings avoid ambiguity about sibling
workspace/lockfile paths.

For a full monorepo build rather than backend-only deployment, use
`npm ci --include=dev && npm run build` — that also builds the Next frontend. Both paths now enforce
the same compiler. Do not set sandbox Prisma engine flags on Render.

Clear Render's build cache once after correcting the settings and confirm the logged TypeScript
versions before compilation. Preserve the database/session/encryption secrets. See
[production startup](render-api-production.md) for runtime DB/Redis/Telegram/storage requirements and
safe migration handling; do not reset data to fix a compiler mismatch.


## Follow-up: explicit TypeScript 5.9.3 pin

At the user's explicit request, root and all six workspace devDependencies now pin exactly
`typescript: 5.9.3`. The existing root `$typescript` override continues to enforce the same version
for transitive consumers. `npm install` regenerated the root lockfile with the 5.9.3 tarball and
integrity and updated each workspace record; no unrelated lockfile dependency update occurred.
The compiler regression test expectations/fixtures now use 5.9.3. No tsconfig, application logic,
authentication, database architecture, production command or deployment configuration changed.

Before installation no node_modules compiler was present in this checkout; the previous committed
pin/lockfile was 5.7.2. Render's failing installed compiler remains unknown from the diagnostic alone.
After installation `npx tsc --version` prints **Version 5.9.3**, and `npm run check:typescript` confirms
root plus every workspace resolves that version. Legacy CommonJS/Node resolution and the existing
Next Bundler configuration remain unchanged.

Commands/results:

- `npm install`: exit 0; lockfile synchronized. No npm audit fix command was run.
- `npx tsc --version`: exit 0, Version 5.9.3.
- `npm run check:typescript`: exit 0, all locations 5.9.3.
- `npm run build`: exit 1 at the Prisma native schema-engine download from binaries.prisma.sh,
  blocked by this sandbox's network/TLS restrictions. No TS5108 occurred before that blocker.
- Full root build with sandbox-only engine-free Prisma generation:

  ```sh
  PRISMA_GENERATE_NO_ENGINE=1 \
  PRISMA_QUERY_ENGINE_LIBRARY=/bin/true \
  PRISMA_QUERY_ENGINE_BINARY=/bin/true \
  PRISMA_SCHEMA_ENGINE_BINARY=/bin/true \
  npm run build
  ```

  Exit 0: shared-types, validation, platform-connectors, database, API and Next production build
  all passed with TypeScript 5.9.3. No TS5108. This is not an unqualified native production build:
  never copy the sandbox flags to Render. Native engine generation/deployment remain unverified.
- `SESSION_SECRET=isolated-unit-test-secret-not-for-production-12345 npx vitest run --config tests/vitest.config.ts`:
  exit 0, **344 passed, 3 opt-in cases skipped**, 45 files.
- Compiled `apps/api/dist/main.js`: exists. API start:prod: `node dist/main.js`, unchanged.
- `git diff --check`: passed.

Changed files: root package.json and package-lock.json; apps/api/package.json;
apps/web/package.json; packages/database/package.json; packages/platform-connectors/package.json;
packages/shared-types/package.json; packages/validation/package.json;
tests/unit/typescript-toolchain.test.ts; this document.

Existing Render configuration remains valid: repository-root working directory,
`npm ci --include=dev && npm run build:api` for backend-only build, `npm run start:api` delegating to
API start:prod, NODE_ENV=production and NODE_VERSION=22.22.3. The full-monorepo equivalent is
`npm ci --include=dev && npm run build`. Clear the build cache after merging and inspect the logged
compiler versions. No production deployment success is claimed.
