# ADR-0007: Suppress esbuild dev-server advisory (GHSA-67mh-4wv8-2f99)

- **Status:** Accepted
- **Date:** 2026-04-05
- **Confidence:** High

## Context

CI runs `npm audit --audit-level=moderate`. As of 2026-04-05, 4 moderate findings all trace to a single advisory:

```
drizzle-kit@0.31.10
  → @esbuild-kit/esm-loader (deprecated, merged into tsx)
    → @esbuild-kit/core-utils
      → esbuild@0.18.20 (<=0.24.2, vulnerable)
```

**GHSA-67mh-4wv8-2f99**: esbuild's dev server (`esbuild.serve()`) accepts cross-origin requests, letting any website read responses from it.

### Why this is unexploitable here

1. **Dead dependency.** drizzle-kit's bundled code (bin.cjs, api.js, index.js, utils.js, and .mjs variants) contains zero references to `@esbuild-kit`. Declared in `package.json`, never imported. drizzle-kit already ships `tsx: ^4.21.0` and `esbuild: ^0.25.4` as direct deps — the `@esbuild-kit` chain is a pre-migration leftover.
2. **Vulnerable API never called.** `@esbuild-kit/core-utils` only invokes `esbuild.transform()` (6×) and `esbuild.build()` (2×), never `esbuild.serve()`. The vulnerability requires `serve()`.

The whole chain is a devDependency — excluded from the production Docker image (`npm ci --omit=dev`).

## Decision

Suppress GHSA-67mh-4wv8-2f99 in the CI audit step via a targeted `jq` filter on `npm audit --json`. Any advisory not in the suppression list still fails CI.

## Alternatives Considered

### `npm audit --omit=dev`

Suppresses all devDependency vulnerabilities. Too broad — a future critical in vitest, eslint, or playwright would be silently ignored.

### npm overrides to force esbuild >=0.25.0

Overriding dead code drizzle-kit never imports cannot fix a problem that doesn't manifest at runtime.

### Wait for upstream fix

drizzle-team/drizzle-orm#5304 tracks this; the fix is in the drizzle-kit beta but not stable. CI cannot block on an upstream timeline we don't control.

## Review Trigger

Remove this suppression when any becomes true:

- `npm view drizzle-kit dist-tags.latest` no longer declares `@esbuild-kit/esm-loader` (expected once drizzle-kit 1.0.0 stable ships — see status below)
- drizzle-team/drizzle-orm#5304 closes
- The advisory is withdrawn

## Upstream Status

**Last checked: 2026-04-17**

- Stable `drizzle-kit@0.31.10` still declares `@esbuild-kit/esm-loader`. No stable release has addressed the chain since this ADR was written (2026-04-05).
- Beta `drizzle-kit@1.0.0-beta.22` drops `@esbuild-kit/*` and `tsx`, switches to `jiti` as runtime loader, pins `esbuild ^0.25.10` (above the vulnerable range). Moving our devDependency to the beta was rejected: migration tooling is a schema/data-corruption-critical code path, and the exploitability analysis above already shows zero runtime risk from staying on stable.
- drizzle-team/drizzle-orm#5304 still OPEN; last activity 2026-03-24.
