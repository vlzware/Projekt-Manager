import { test, expect, type Route } from '@playwright/test';
import fs from 'node:fs';
import { STORAGE_STATES } from './storage-states';
import { clickView } from './nav-helpers';

/**
 * Pull a fresh AES-256-GCM fixture for one attachment row. Returns the
 * triple the descriptor surface and the storage URL would normally hand
 * the client: `dekMaterial` for the descriptor's `originalDekMaterial`,
 * `ciphertext` (= nonce(12) || aesGcm(plaintext) || authTag(16)) for the
 * 200-response body, and the original `plaintext` for any byte-equality
 * assertion the caller wants. Wire shape per ADR-0024 §Encryption.
 */
async function makeAesGcmFixture(plaintextString: string): Promise<{
  plaintext: Uint8Array;
  ciphertext: Uint8Array;
  dekMaterial: string;
}> {
  const dek = new Uint8Array(32);
  crypto.getRandomValues(dek);
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const plaintext = new TextEncoder().encode(plaintextString);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    dek,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );
  const ctWithTag = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cryptoKey, plaintext),
  );
  const ciphertext = new Uint8Array(nonce.byteLength + ctWithTag.byteLength);
  ciphertext.set(nonce, 0);
  ciphertext.set(ctWithTag, nonce.byteLength);
  const dekMaterial = btoa(String.fromCharCode(...dek));
  return { plaintext, ciphertext, dekMaterial };
}

/**
 * Enumerate filenames inside a zip via the central directory. APPNOTE.TXT
 * §4.3.16 (End-of-Central-Directory Record) + §4.3.12 (Central Directory
 * File Header). The EOCD record is at the tail of the file (signature
 * 0x06054b50); it points at the central directory offset and length, and
 * each CDFH entry there carries the filename. Filenames-only — sizes,
 * CRCs, and bytes are intentionally not surfaced (the AC-249 / AC-251
 * arms only need to assert path presence, not byte equality; the unit
 * test under `src/ui/management/__tests__/data-exchange-export-all-zip.test.ts`
 * already pins byte-equality at the helper boundary). Throws on a
 * malformed zip or a missing EOCD signature.
 */
function listZipEntries(zip: Buffer): Set<string> {
  const EOCD_SIG = 0x06054b50;
  const CDFH_SIG = 0x02014b50;
  // EOCD is variable-length (trailing comment up to 65535 bytes); scan
  // backwards from the end for the signature. The fixtures here have no
  // comment, so the EOCD typically sits in the last 22 bytes.
  let eocdOff = -1;
  const minEocd = 22;
  const maxScanBack = Math.min(zip.length, 22 + 0xffff);
  for (let i = zip.length - minEocd; i >= zip.length - maxScanBack; i -= 1) {
    if (zip.readUInt32LE(i) === EOCD_SIG) {
      eocdOff = i;
      break;
    }
  }
  if (eocdOff < 0) throw new Error('listZipEntries: EOCD signature not found');
  const cdSize = zip.readUInt32LE(eocdOff + 12);
  const cdOff = zip.readUInt32LE(eocdOff + 16);
  const cdEnd = cdOff + cdSize;
  const out = new Set<string>();
  let off = cdOff;
  while (off < cdEnd) {
    if (zip.readUInt32LE(off) !== CDFH_SIG) {
      throw new Error(`listZipEntries: bad central-dir entry at offset ${off}`);
    }
    const fnLen = zip.readUInt16LE(off + 28);
    const extraLen = zip.readUInt16LE(off + 30);
    const commentLen = zip.readUInt16LE(off + 32);
    const fnStart = off + 46;
    out.add(zip.subarray(fnStart, fnStart + fnLen).toString('utf-8'));
    off = fnStart + fnLen + extraLen + commentLen;
  }
  return out;
}

/**
 * E2E — Vollständiger Export (AC-249 + AC-251).
 *
 * Pins the user-visible flow on `Daten → "Vollständiger Export"`:
 *
 *   AC-249  Pre-flight (totalCount + totalSizeBytes single up-front
 *           readout) → progress dialog (files-done / total, bytes-done /
 *           total, current-file name, "Abbrechen") → cancel halts
 *           in-flight fetch and closes the dialog → resulting zip
 *           filename `projekt-manager-export-<TIMESTAMP>.zip`
 *           → small-viewport non-blocking warning
 *           `"Für Desktop-Nutzung gedacht; Downloads können sehr groß sein."`
 *   AC-251  Per-file failure does not abort the export. Skip causes:
 *           descriptor `error = 'DEK_UNWRAP_FAILED'`, single-retry URL
 *           expiry that recovers, double-retry URL expiry that skips,
 *           ciphertext fetch 5xx that skips. Post-export summary
 *           renders `"X Dateien übersprungen"` for the cumulative skip
 *           count.
 *
 * testids introduced by this spec (the UI implementation must match):
 *   data-export-button             single "Export" trigger
 *   export-all-preflight               pre-flight confirmation dialog
 *   export-all-preflight-count         attachment-count readout (totalCount)
 *   export-all-preflight-size          aggregate plaintext size (totalSizeBytes)
 *   export-all-preflight-mobile-warning  the small-viewport warning copy
 *   export-all-preflight-confirm       confirm-and-start action
 *   export-all-progress                progress dialog
 *   export-all-progress-counter        files-done / total
 *   export-all-progress-bytes          bytes-done / total
 *   export-all-progress-current-file   current-file name display
 *   export-all-cancel                  Abbrechen action
 *   export-all-summary                 post-export summary panel
 *   export-all-summary-skipped         "X Dateien übersprungen" line
 *
 * Spec ambiguity / implementation-side assumption documented here:
 *   The brief calls for seeding (a) a `DEK_UNWRAP_FAILED` row on the
 *   descriptor surface, (b) a row whose presigned URL expires once and
 *   recovers via a single page re-fetch, (c) a row whose URL expires
 *   twice (skipped after the bounded retry), and (d) a row whose
 *   ciphertext fetch returns 5xx. There is no current test seeding
 *   affordance that produces (a) or (b)/(c)'s force-aged URLs through
 *   the real DB layer in an e2e context.
 *
 *   Approach: scenarios (a)–(d) are simulated at the network layer via
 *   `page.context().route()` — Playwright intercepts the descriptor
 *   surface and the ciphertext storage URLs, and replays canned
 *   responses that match the AC-248 wire shape. The descriptor cursor
 *   stability does not need to be proven here (AC-248 covers it at the
 *   integration layer); what AC-251 pins is the CLIENT BEHAVIOR
 *   downstream of those wire responses.
 *
 *   A real test-seeding helper that produces these row states through
 *   the DB layer would let the route mocks below be replaced with seeded
 *   rows. The mocks faithfully encode the wire contract pinned by
 *   AC-248, so the assertion targets do not change.
 */

test.use({ storageState: STORAGE_STATES.owner });
test.describe.configure({ mode: 'serial' });

// ---------------------------------------------------------------
// AC-249 — pre-flight + progress + cancel + mobile warning + filename.
//
// All four pieces in one test block per the brief's structure:
//   - pre-flight dialog renders totalCount + totalSizeBytes
//   - progress dialog renders files-done/total + bytes-done/total +
//     current-file name
//   - "Abbrechen" halts the in-flight fetch and closes the dialog
//   - small-viewport non-blocking warning copy
//   - resulting download filename matches the spec format
//
// One block, four arms — keeps AC-249's full surface in a single
// trace if it fails.
// ---------------------------------------------------------------
test('AC-249: pre-flight + progress + cancel + mobile warning', async ({ page }) => {
  const FIXED_TOTAL_COUNT = 3;
  const FIXED_TOTAL_BYTES = 4_500_000;

  // Stage the descriptor surface response. The pre-flight dialog reads
  // `totalCount` and `totalSizeBytes` straight from the first-page
  // descriptor body — that's the single up-front readout AC-249 names.
  await page.context().route('**/api/export/binary-descriptors**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        entries: [
          {
            attachmentId: 'aaaaaaaa-0000-4000-8000-000000000001',
            projectId: 'p1',
            projectNumber: '2026-001',
            projectTitle: 'A',
            fileName: 'first.bin',
            sizeBytes: 1_500_000,
            originalUrl: 'https://storage.test/A.ct',
            // 32-byte b64-decode placeholder; the assembly helper
            // validates length, but pre-flight + progress dialog
            // assertions read totalCount + totalSizeBytes only — no
            // crypto runs against this material in the cancel arm.
            originalDekMaterial: 'A'.repeat(44),
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
          {
            attachmentId: 'bbbbbbbb-0000-4000-8000-000000000002',
            projectId: 'p1',
            projectNumber: '2026-001',
            projectTitle: 'A',
            fileName: 'second.bin',
            sizeBytes: 1_500_000,
            originalUrl: 'https://storage.test/B.ct',
            originalDekMaterial: 'B'.repeat(44),
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
          {
            attachmentId: 'cccccccc-0000-4000-8000-000000000003',
            projectId: 'p1',
            projectNumber: '2026-001',
            projectTitle: 'A',
            fileName: 'third.bin',
            sizeBytes: 1_500_000,
            originalUrl: 'https://storage.test/C.ct',
            originalDekMaterial: 'C'.repeat(44),
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        ],
        nextCursor: null,
        totalCount: FIXED_TOTAL_COUNT,
        totalSizeBytes: FIXED_TOTAL_BYTES,
      }),
    });
  });

  // Stall the ciphertext fetches so the progress dialog has time to
  // render and the cancel arm has an in-flight fetch to halt. A
  // never-resolving handler keeps the helper blocked on the first
  // file forever — the cancel observation does not need a completed
  // download. The handler must NOT call fulfill / abort.
  await page.context().route('https://storage.test/**', () => {
    /* keep the request pending until the test ends */
  });

  // ---------------------------------------------------------------
  // Arm 1 — small-viewport mobile warning. Resize first so the
  // warning is rendered on the very first preflight open.
  // ---------------------------------------------------------------
  await page.setViewportSize({ width: 480, height: 800 });
  await page.goto('/');
  await clickView(page, 'daten');
  await expect(page.getByTestId('daten-view')).toBeVisible();

  const exportAllButton = page.getByTestId('data-export-button');
  await expect(exportAllButton).toBeVisible();
  await exportAllButton.click();

  let preflight = page.getByTestId('export-all-preflight');
  await expect(preflight).toBeVisible();

  // Warning copy is spec-pinned verbatim.
  const warning = preflight.getByTestId('export-all-preflight-mobile-warning');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(
    'Für Desktop-Nutzung gedacht; Downloads können sehr groß sein.',
  );
  // Non-blocking — confirm stays enabled.
  await expect(preflight.getByTestId('export-all-preflight-confirm')).toBeEnabled();

  // Close the preflight (Escape is the standard dialog dismissal) so
  // the next arm opens a fresh dialog at desktop viewport.
  await page.keyboard.press('Escape');
  await expect(preflight).toBeHidden();

  // ---------------------------------------------------------------
  // Arm 2 — pre-flight readout + progress dialog + cancel. Restore a
  // desktop viewport so the mobile warning is gone (parity with the
  // documented affordance scope).
  // ---------------------------------------------------------------
  await page.setViewportSize({ width: 1920, height: 1080 });

  await exportAllButton.click();
  preflight = page.getByTestId('export-all-preflight');
  await expect(preflight).toBeVisible();

  // Pre-flight count + size — single up-front readout from the first-
  // page descriptor body (server-computed totalCount + totalSizeBytes).
  await expect(preflight.getByTestId('export-all-preflight-count')).toContainText(
    String(FIXED_TOTAL_COUNT),
  );
  const sizeReadout = preflight.getByTestId('export-all-preflight-size');
  await expect(sizeReadout).toBeVisible();
  // Display format is implementation-defined (B / KB / MB / etc.); the
  // contract is that the size is rendered. Any digit suffices to
  // distinguish from "missing" or "—".
  await expect(sizeReadout).toContainText(/\d/);

  // Confirm + drain — progress dialog opens.
  await preflight.getByTestId('export-all-preflight-confirm').click();

  const progress = page.getByTestId('export-all-progress');
  await expect(progress).toBeVisible();

  // Files-done / total — both sides of the slash are rendered. With
  // all ciphertext fetches stalled the counter sits at 0 / 3.
  await expect(progress.getByTestId('export-all-progress-counter')).toContainText(
    String(FIXED_TOTAL_COUNT),
  );
  // Bytes-done / total — the total side shows the upfront
  // FIXED_TOTAL_BYTES; bytes-done starts at 0. Asserting against
  // `data-bytes-total` rather than visible text keeps the user-facing
  // copy free of raw byte counts (`4.29 MB` is what users see, not
  // `4.29 MB (4500000)`); the data-attribute is the contract surface
  // for tests, the rendered string is the contract surface for users.
  await expect(progress.getByTestId('export-all-progress-bytes')).toHaveAttribute(
    'data-bytes-total',
    String(FIXED_TOTAL_BYTES),
  );
  // Current file — helper drains in cursor order, so the first
  // entry's fileName is what the dialog surfaces.
  await expect(progress.getByTestId('export-all-progress-current-file')).toContainText(
    'first.bin',
  );

  // Cancel halts the in-flight fetch and closes the dialog
  // immediately. The "partial download is the user's to discard"
  // contract is non-observable from the page; what's observable is
  // the dialog teardown.
  await progress.getByTestId('export-all-cancel').click();
  await expect(progress).toBeHidden();

  // ---------------------------------------------------------------
  // Arm 3 — happy-path download. Re-stage the descriptor route AND
  // the storage route to deliver ONE fetchable attachment with real
  // AES-256-GCM ciphertext, so the assembled zip is non-empty. The
  // filename regex check below was vacuous against `entries: []` — a
  // regression in the fetch wiring, decrypt path, or zip layout would
  // still pass it. With one real entry in the zip, the same filename
  // assertion AND the zip-layout assertions (data.json, manifest.json,
  // attachment under AC-250's `attachments/<projektnummer>-<projekt-titel>/<attachment-id>-<dateiname>`)
  // all become load-bearing.
  //
  // The storage URL also needs to be unrouted from Arm 1/2's stall.
  // ---------------------------------------------------------------
  await page.context().unroute('**/api/export/binary-descriptors**');
  await page.context().unroute('https://storage.test/**');

  const armThreeFixture = await makeAesGcmFixture('AC-249-arm3-payload');
  const armThreeAttachmentId = 'aaaaaaaa-0000-4000-8000-00000000a249';
  const armThreeProjectNumber = '2026-249';
  const armThreeProjectTitle = 'Arm3';
  const armThreeFileName = 'happy.bin';
  const armThreeStorageUrl = 'https://storage.test/arm3.ct';

  await page.context().route('**/api/export/binary-descriptors**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        entries: [
          {
            attachmentId: armThreeAttachmentId,
            projectId: 'p249',
            projectNumber: armThreeProjectNumber,
            projectTitle: armThreeProjectTitle,
            fileName: armThreeFileName,
            sizeBytes: armThreeFixture.plaintext.byteLength,
            originalUrl: armThreeStorageUrl,
            originalDekMaterial: armThreeFixture.dekMaterial,
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        ],
        nextCursor: null,
        totalCount: 1,
        totalSizeBytes: armThreeFixture.plaintext.byteLength,
      }),
    });
  });
  await page.context().route(armThreeStorageUrl, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      // Buffer wrap — see the AC-251 arm's note on Playwright's
      // base64-encode of non-string fulfill bodies.
      body: Buffer.from(armThreeFixture.ciphertext),
    });
  });

  await exportAllButton.click();
  preflight = page.getByTestId('export-all-preflight');
  await expect(preflight).toBeVisible();

  const downloadPromise = page.waitForEvent('download', { timeout: 15_000 });
  await preflight.getByTestId('export-all-preflight-confirm').click();
  const download = await downloadPromise;

  // AC-249 filename format:
  //   projekt-manager-export-<YYYY-MM-DD>T<HH-mm-ss>.zip
  expect(download.suggestedFilename()).toMatch(
    /^projekt-manager-export-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.zip$/,
  );

  // Zip layout: data.json + manifest.json at the root, plus the one
  // attachment under AC-250's path schema. The unit test pins byte-
  // equality at the helper boundary — here we only assert the layout
  // contract surfaces end-to-end through the real download.
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  const zipBytes = fs.readFileSync(downloadPath!);
  const entries = listZipEntries(zipBytes);
  expect(entries.has('data.json')).toBe(true);
  expect(entries.has('manifest.json')).toBe(true);
  const expectedAttachmentPath = `attachments/${armThreeProjectNumber}-${armThreeProjectTitle}/${armThreeAttachmentId}-${armThreeFileName}`;
  expect(entries.has(expectedAttachmentPath)).toBe(true);
});

// ---------------------------------------------------------------
// AC-251 — per-file failure surfaces in post-export summary.
// ---------------------------------------------------------------
test('AC-251: per-file failure surfaces in post-export summary', async ({ page }) => {
  // Four-row dataset modeled as a single-page descriptor response:
  //   (a) error = 'DEK_UNWRAP_FAILED'  → skipped without a fetch attempt
  //   (b) URL expires once, recovers   → succeeds via a single page re-fetch
  //   (c) URL expires twice            → skipped after the bounded retry
  //   (d) ciphertext fetch returns 5xx → skipped
  //
  // Skip-count = 3 (a + c + d). Entry (b) lands successfully.
  //
  // For (b) the bounded-retry behavior is wire-side: the AC-248
  // contract says one re-fetch of the affected page on URL expiry.
  // We model that with a per-page mock that returns "expired"-marker
  // URLs the first time and "fresh" URLs on the second call.
  //
  // The "expired" detection is modeled as the storage URL responding
  // with a 403 (the canonical AWS S3 expiry surface). The client
  // distinguishes 403 from 5xx and only treats 403 as the expired-URL
  // re-fetch trigger.
  //
  // Implementation note: descriptor pagination is single-page in this
  // test (nextCursor = null) since AC-251's contract does not require
  // multi-page iteration — the re-fetch is on the SAME page, not a
  // next page. The page-level GET is what the client re-issues.

  // Stage real AES-256-GCM ciphertext for B-fresh.ct so entry (b)
  // genuinely decrypts and lands in the zip. If `B-fresh.ct` returned
  // arbitrary bytes the client would skip on decrypt failure, the
  // skip-count would be 4 (not 3), and the assertion below would still
  // pass under a regression where bounded-retry never fires (every
  // entry skips for a different reason). Encrypting under a real DEK
  // makes the "3 Dateien übersprungen" assertion load-bearing.
  //
  // Wire shape per ADR-0024 §Encryption — see `makeAesGcmFixture`. The
  // DEK base64 must match between the descriptor's
  // `originalDekMaterial` and the fixture key — it's threaded through
  // both descriptor responses (first page + re-fetch).
  const bFixture = await makeAesGcmFixture('fixture-B-recovered');
  const { ciphertext: bCiphertext, dekMaterial: bDekMaterial } = bFixture;

  let descriptorCallCount = 0;
  await page.context().route('**/api/export/binary-descriptors**', async (route: Route) => {
    descriptorCallCount += 1;
    // First call: B's URL is "to-expire", C's URL is "always-expires"
    // (both are responded to with 403 below). Second call (the
    // bounded-retry triggered by B's first 403): B's URL is "fresh"
    // (responds 200), C's URL stays "always-expires" (still 403).
    const bUrl = descriptorCallCount === 1 ? 'https://storage.test/B-stale.ct' : 'https://storage.test/B-fresh.ct';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        entries: [
          {
            attachmentId: 'aaaaaaaa-0000-4000-8000-000000000001',
            projectId: 'p1',
            projectNumber: '2026-001',
            projectTitle: 'A',
            fileName: 'corrupt.bin',
            sizeBytes: 100,
            error: 'DEK_UNWRAP_FAILED',
          },
          {
            attachmentId: 'bbbbbbbb-0000-4000-8000-000000000002',
            projectId: 'p1',
            projectNumber: '2026-001',
            projectTitle: 'A',
            fileName: 'recovers.bin',
            sizeBytes: bFixture.plaintext.byteLength,
            originalUrl: bUrl,
            // Same DEK on both descriptor calls — the row is the same
            // attachment, only the presigned URL was refreshed.
            originalDekMaterial: bDekMaterial,
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
          {
            attachmentId: 'cccccccc-0000-4000-8000-000000000003',
            projectId: 'p1',
            projectNumber: '2026-001',
            projectTitle: 'A',
            fileName: 'twice-expired.bin',
            sizeBytes: 300,
            originalUrl: 'https://storage.test/C-expired.ct',
            originalDekMaterial: 'C'.repeat(44),
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
          {
            attachmentId: 'dddddddd-0000-4000-8000-000000000004',
            projectId: 'p1',
            projectNumber: '2026-001',
            projectTitle: 'A',
            fileName: 'storage-5xx.bin',
            sizeBytes: 400,
            originalUrl: 'https://storage.test/D-5xx.ct',
            originalDekMaterial: 'D'.repeat(44),
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        ],
        nextCursor: null,
        totalCount: 4,
        totalSizeBytes: 100 + bFixture.plaintext.byteLength + 300 + 400,
      }),
    });
  });

  // Stale-URL responses → 403 (canonical S3-expiry surface).
  await page.context().route('https://storage.test/B-stale.ct', async (route) => {
    await route.fulfill({ status: 403, body: 'AccessDenied' });
  });
  await page.context().route('https://storage.test/C-expired.ct', async (route) => {
    await route.fulfill({ status: 403, body: 'AccessDenied' });
  });
  // Fresh URL after the page re-fetch → 200 with REAL AES-256-GCM
  // ciphertext bytes that decrypt under `bDekMaterial`. Entry (b)
  // genuinely recovers and lands in the zip; the skip-count below is
  // load-bearing because (b) is NOT among the skipped.
  await page.context().route('https://storage.test/B-fresh.ct', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      // Wrap in Buffer: Playwright's client-side fulfill calls
      // `body.toString("base64")` on non-string truthy bodies (see
      // playwright-core/lib/client/network.js:304). For a plain
      // Uint8Array, `.toString('base64')` is inherited from
      // TypedArray.prototype.toString — it ignores the argument and
      // returns comma-separated decimals (e.g. "10,232,5,…"), which
      // corrupts on base64-decode. Buffer's override does the right
      // thing.
      body: Buffer.from(bCiphertext),
    });
  });
  // Storage 5xx → skipped.
  await page.context().route('https://storage.test/D-5xx.ct', async (route) => {
    await route.fulfill({ status: 503, body: 'ServiceUnavailable' });
  });

  await page.goto('/');
  await clickView(page, 'daten');
  await page.getByTestId('data-export-button').click();

  const preflight = page.getByTestId('export-all-preflight');
  await expect(preflight).toBeVisible();

  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
  await preflight.getByTestId('export-all-preflight-confirm').click();
  const download = await downloadPromise;

  // The export ran to completion despite (a) + (c) + (d) skipping.
  expect(download.suggestedFilename()).toMatch(/\.zip$/);

  // Post-export summary: at least one entry skipped → "X Dateien
  // übersprungen". The skip count is 3 (a + c + d). Entry (b) recovered
  // via the single bounded retry — it is NOT in the skipped count.
  const summary = page.getByTestId('export-all-summary');
  await expect(summary).toBeVisible();
  const skipped = summary.getByTestId('export-all-summary-skipped');
  await expect(skipped).toBeVisible();
  await expect(skipped).toContainText('3 Dateien übersprungen');

  // Sanity: the bounded-retry actually fired. Two descriptor calls =
  // first-page + one re-fetch. A regression that retried twice (or
  // not at all) would surface here.
  expect(descriptorCallCount).toBe(2);

  // Pin which row recovered: the bounded retry must have refreshed
  // entry (b)'s URL, so `recovers.bin` is in the zip. Skip-count alone
  // (`3 Dateien übersprungen`) + descriptorCallCount === 2 would still
  // pass under a regression that retried row (c) instead of (b) and
  // skipped (b) — same skip total, same retry count, wrong row
  // recovered. Path-presence in the zip is what locks the row.
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  const zipBytes = fs.readFileSync(downloadPath!);
  const entries = listZipEntries(zipBytes);
  const bAttachmentPath =
    'attachments/2026-001-A/bbbbbbbb-0000-4000-8000-000000000002-recovers.bin';
  expect(entries.has(bAttachmentPath)).toBe(true);
});
