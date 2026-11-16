# `packages/validation`

One zod schema per request/response contract, imported by the API (to parse) and the web app (to
type its forms). Adding an endpoint means adding a schema here first, so both sides cannot drift.

Conventions: `.strict()` where extra fields are a bug, `z.coerce` for query strings, human-readable
error messages (they are shown to the user verbatim).

## Runtime entry and rebuild order

Node and Next resolve this workspace through `main: dist/index.js`; TypeScript uses
`types: dist/index.d.ts`. There is no source export condition. Both files must be generated from
the same source revision. Do not commit `dist`, add duplicate schema imports, or suppress runtime
validation when a schema export is missing.

`npm run build -w @clipforge/validation` first builds its runtime dependency
`@clipforge/shared-types`. Web and API `predev`, `prebuild` and `pretypecheck` hooks rebuild validation,
so normal npm entry commands cannot silently consume a previous revision's schema exports. These
hooks run from either the repository root or the app workspace directory. Build errors stop startup.
Use npm scripts rather than invoking `next` or `tsc` directly; `--ignore-scripts` bypasses hooks.

After pulling schema changes, restart development through `npm run dev:web` / `npm run dev:api`.
For production, rebuild through `npm run build`; `npm start` serves an already-built artifact and
cannot refresh a previously bundled Next client. Running development servers do not watch shared
schema sources automatically: restart after editing them.

Unit tests normally alias imports to TypeScript source. `tests/unit/validation-package-entry.test.ts`
also loads the real built package in fresh Node processes from both app directories, catching absent
or incorrectly initialized runtime exports that source-only tests cannot detect.
