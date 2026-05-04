/**
 * Shared constant between the page-side `streamingDownload` helper and
 * the SW-side `streamingDownload` handler. The SW source bundles
 * separately from the SPA (Vite emits `/sw.js` standalone), so this
 * file is duplicated by import: both sides land on the same literal at
 * build time. Keep the value in sync with `src/sw/streamingDownload.ts`
 * `STREAMING_DOWNLOAD_PREFIX`.
 */
export const STREAMING_DOWNLOAD_PREFIX = '/streaming-download/';
