# ADR-0007: Suppress esbuild dev-server advisory (GHSA-67mh-4wv8-2f99)

- **Status:** Superseded by PR #195 (2026-05-15)
- **Date:** 2026-04-05
- **Confidence:** High

## Supersession

A scoped npm override now pins `@esbuild-kit/core-utils > esbuild` to
`^0.25.0`, taking the nested copy out of the vulnerable `<=0.24.2` range.
`npm audit` reports zero advisories; the CI suppression block is gone.

The original ADR was right that the override patches an unused chain —
the static-analysis evidence in Context §1-2 below still holds, and
runtime exposure is zero either way. The override is cosmetic for risk.
We're doing it anyway: one `package.json` line beats a per-advisory CI
bypass, and a clean `npm audit` is worth more than a hand-maintained
allowlist. The original ADR weighed runtime risk only; this trade-off
on signal hygiene wasn't on the table.

The drizzle-kit `generate` smoke after the bump confirms the override
doesn't disturb drizzle-kit's actual loader path (drizzle-kit's bundled
code never imports `@esbuild-kit` — see Context §1).

The original record is preserved below.

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

drizzle-team/drizzle-orm#5304 tracks the upstream fix (drizzle-kit
1.0.0-beta drops `@esbuild-kit/*` for `jiti`). When that ships stable,
both the override and this ADR can be deleted.
