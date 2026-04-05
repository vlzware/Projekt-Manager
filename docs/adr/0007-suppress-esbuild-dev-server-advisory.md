# ADR-0007: Suppress esbuild dev-server advisory (GHSA-67mh-4wv8-2f99)

- **Status:** Accepted
- **Date:** 2026-04-05
- **Confidence:** High

## Context

CI runs `npm audit --audit-level=moderate`. As of 2026-04-05 this reports 4 moderate-severity findings, all tracing to a single advisory:

```
drizzle-kit@0.31.10
  → @esbuild-kit/esm-loader (deprecated, merged into tsx)
    → @esbuild-kit/core-utils
      → esbuild@0.18.20 (<=0.24.2, vulnerable)
```

**GHSA-67mh-4wv8-2f99**: esbuild's dev server (`esbuild.serve()`) accepts cross-origin requests, allowing any website to read responses from the development server.

### Why this is unexploitable here

Two independent reasons:

1. **Dead dependency.** drizzle-kit's bundled code (bin.cjs, api.js, index.js, utils.js, and .mjs variants) contains zero references to `@esbuild-kit`. The dependency is declared in drizzle-kit's `package.json` but never imported. drizzle-kit already ships `tsx: ^4.21.0` and `esbuild: ^0.25.4` as direct dependencies — the `@esbuild-kit` chain is a leftover from before the migration.
2. **Vulnerable API never called.** Even if the code were reached, `@esbuild-kit/core-utils` only calls `esbuild.transform()` (6 occurrences) and `esbuild.build()` (2 occurrences), never `esbuild.serve()`. The vulnerability requires `serve()` to be invoked.

Additionally, this entire chain is a devDependency — it is excluded from the production Docker image (`npm ci --omit=dev`).

## Decision

Suppress GHSA-67mh-4wv8-2f99 in the CI audit step using a targeted `jq` filter on `npm audit --json` output. Any advisory not in the suppression list still fails CI.

## Alternatives Considered

### `npm audit --omit=dev`

Suppresses all devDependency vulnerabilities. Too broad — a future critical vulnerability in vitest, eslint, or playwright would be silently ignored.

### npm overrides to force esbuild >=0.25.0

Unnecessary complexity. The overridden dependency is dead code that drizzle-kit never imports. The override cannot fix a problem that does not manifest at runtime.

### Wait for upstream fix

drizzle-team/drizzle-orm#5304 tracks this. The fix exists in the drizzle-kit beta channel but has not shipped to stable. We cannot block CI on an upstream timeline we do not control.

## Review Trigger

Remove this suppression when either:

- drizzle-kit stable drops the `@esbuild-kit/esm-loader` dependency (check on each drizzle-kit upgrade)
- The advisory is withdrawn
