/**
 * Service Worker decrypt handler — pinned by AC-243 in
 * docs/spec/verification.md §15.26 and the synthetic-origin contract in
 * ui/project-detail.md §8.15.4 / §8.15.5.
 *
 * The Service Worker installed by the SPA intercepts every request to
 * `/encrypted-storage/<projectId>/<attachmentId>.<variant>`
 * (`variant ∈ {original, thumbnail}`), then:
 *
 *   1. calls `GET /api/projects/:id/attachments/:attId/download-url?variant=<variant>`
 *      to obtain `{ url, expiresAt, dekMaterial }`;
 *   2. fetches `url` to obtain the ciphertext bytes from object storage;
 *   3. AES-256-GCM-decrypts with `dekMaterial` (per-blob nonce is the
 *      ciphertext's leading 12 bytes per ADR-0024 §Encryption);
 *   4. returns the plaintext bytes via the Fetch response.
 *
 * Pure-handler scope: vitest + jsdom does not host a real Service Worker
 * lifecycle, so the test exercises the handler function in isolation —
 * `handleEncryptedStorageRequest(request)` consumes a `Request` and
 * resolves to a `Response`. Mocks: the global `fetch` (for both the
 * download-url JSON call and the ciphertext-bytes call). The test
 * asserts the wire shape (URL, response shape) and the cryptographic
 * contract (decryption produces the original plaintext).
 *
 * NOTE — failing-test step (CONTRIBUTING.md § Workflow step 3): the
 * import `@/sw/decryptHandler` does not exist yet. This file pins the
 * AC-243 contract; the implementer iteration adds the module.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The handler under test — implementation does not exist yet (step 3
// of the workflow). The first failure surfaces as an unresolved import.
const { handleEncryptedStorageRequest } = await import('@/sw/decryptHandler');

// ---------------------------------------------------------------------------
// Test crypto helpers — local to this file, NOT the production
// `clientEncryption` module. The point is to encrypt synthetic
// plaintexts with the same AES-GCM convention the SW must decrypt
// (12-byte nonce prefixed; 16-byte auth tag appended by WebCrypto).
// Co-locating the helpers makes the test's contract self-evident:
// ciphertext format = nonce(12) || ct || tag(16). If the SW deviates,
// these tests fail.
// ---------------------------------------------------------------------------

const NONCE_BYTES = 12;
const DEK_BYTES = 32;

async function importDek(rawDek: Uint8Array): Promise<CryptoKey> {
  // Copy into a fresh ArrayBuffer-backed view so the SubtleCrypto type
  // signatures (which refuse SharedArrayBuffer-backed views since TS
  // 5.x) accept it. The runtime semantics are identical.
  const buf = new Uint8Array(rawDek.byteLength);
  buf.set(rawDek);
  return crypto.subtle.importKey('raw', buf, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptForTest(plaintext: Uint8Array, rawDek: Uint8Array): Promise<Uint8Array> {
  const key = await importDek(rawDek);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  // Ensure ArrayBuffer-backed buffers — see importDek note.
  const nonceBuf = new Uint8Array(nonce.byteLength);
  nonceBuf.set(nonce);
  const ptBuf = new Uint8Array(plaintext.byteLength);
  ptBuf.set(plaintext);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonceBuf }, key, ptBuf),
  );
  const out = new Uint8Array(NONCE_BYTES + ct.byteLength);
  out.set(nonceBuf, 0);
  out.set(ct, NONCE_BYTES);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

// ---------------------------------------------------------------------------
// Fetch mock — installed on the global so the SW handler reads through
// it. The handler issues two outbound requests per intercept (the
// download-url JSON GET, then the ciphertext GET); the mock returns
// per-URL configurable responses.
// ---------------------------------------------------------------------------

interface FetchPlan {
  downloadUrl?: () => Response | Promise<Response>;
  ciphertext?: () => Response | Promise<Response>;
}

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function installFetchPlan(plan: FetchPlan): void {
  fetchMock.mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
    if (url.includes('/api/projects/') && url.includes('/download-url')) {
      if (!plan.downloadUrl) throw new Error(`unexpected download-url fetch: ${url}`);
      return plan.downloadUrl();
    }
    if (url.startsWith('https://storage.example/')) {
      if (!plan.ciphertext) throw new Error(`unexpected ciphertext fetch: ${url}`);
      return plan.ciphertext();
    }
    throw new Error(`unmocked fetch: ${url}`);
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function syntheticRequest(projectId: string, attachmentId: string, variant: string): Request {
  return new Request(`/encrypted-storage/${projectId}/${attachmentId}.${variant}`);
}

// ---------------------------------------------------------------------------
// AC-243 — happy path + variants
// ---------------------------------------------------------------------------

describe('AC-243: synthetic-origin intercept + decrypt', () => {
  it('decrypts the original-variant ciphertext and returns the plaintext via the Fetch response', async () => {
    const dek = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
    const plaintext = new TextEncoder().encode('Hello, encrypted world.');
    const ciphertext = await encryptForTest(plaintext, dek);

    installFetchPlan({
      downloadUrl: () =>
        jsonResponse({
          url: 'https://storage.example/cipher-original',
          expiresAt: '2026-04-30T12:00:00Z',
          dekMaterial: toBase64(dek),
        }),
      ciphertext: () => new Response(ciphertext.slice() as BlobPart),
    });

    const response = await handleEncryptedStorageRequest(
      syntheticRequest('p-42', 'att-1', 'original'),
    );

    expect(response.status).toBe(200);
    const out = new Uint8Array(await response.arrayBuffer());
    expect(out).toEqual(plaintext);
  });

  it('decrypts the thumbnail-variant ciphertext (different DEK from the original)', async () => {
    const thumbDek = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
    const plaintext = new TextEncoder().encode('thumb-bytes');
    const ciphertext = await encryptForTest(plaintext, thumbDek);

    installFetchPlan({
      downloadUrl: () =>
        jsonResponse({
          url: 'https://storage.example/cipher-thumb',
          expiresAt: '2026-04-30T12:00:00Z',
          dekMaterial: toBase64(thumbDek),
        }),
      ciphertext: () => new Response(ciphertext.slice() as BlobPart),
    });

    const response = await handleEncryptedStorageRequest(
      syntheticRequest('p-42', 'att-1', 'thumbnail'),
    );

    expect(response.status).toBe(200);
    const out = new Uint8Array(await response.arrayBuffer());
    expect(out).toEqual(plaintext);
  });

  it('calls the download-url endpoint with the project id, attachment id, and variant in the query', async () => {
    const dek = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
    const plaintext = new TextEncoder().encode('x');
    const ciphertext = await encryptForTest(plaintext, dek);

    installFetchPlan({
      downloadUrl: () =>
        jsonResponse({
          url: 'https://storage.example/c',
          expiresAt: '2026-04-30T12:00:00Z',
          dekMaterial: toBase64(dek),
        }),
      ciphertext: () => new Response(ciphertext.slice() as BlobPart),
    });

    await handleEncryptedStorageRequest(syntheticRequest('p-42', 'att-7', 'thumbnail'));

    // First outbound call must be the download-url endpoint with the
    // path-derived project id, attachment id, and variant. Asserting on
    // the URL pins the contract — the SW route table treats both
    // variants identically aside from the `?variant=...` query.
    const firstCallUrl = fetchMock.mock.calls[0][0] as string;
    expect(firstCallUrl).toContain('/api/projects/p-42/attachments/att-7/download-url');
    expect(firstCallUrl).toContain('variant=thumbnail');
  });

  it('returns a non-2xx Response when download-url returns 422 DEK_UNWRAP_FAILED so the consumer can render AC-244', async () => {
    // Per api.md §14.2.11 Error paths: a wrapped-envelope unwrap failure
    // surfaces as `422 VALIDATION_ERROR` with `code = DEK_UNWRAP_FAILED`.
    // The SW must translate this into a Response that fails the
    // browser's image / fetch consumer (so `<img onError>` fires and
    // BinaryList's download promise rejects), letting the UI flip to
    // the AC-244 "Schlüssel nicht verfügbar" placeholder.
    installFetchPlan({
      downloadUrl: () =>
        jsonResponse({ code: 'DEK_UNWRAP_FAILED', message: 'envelope unwrap failed' }, 422),
    });

    const response = await handleEncryptedStorageRequest(
      syntheticRequest('p-42', 'att-1', 'thumbnail'),
    );

    expect(response.ok).toBe(false);
    // Error code surfaces in the body so a consumer that wants to
    // distinguish AC-244 (key-unavailable) from AC-224 (bytes-missing)
    // can do so without a second request.
    const body = await response.json();
    expect(body.code).toBe('DEK_UNWRAP_FAILED');
  });

  it('returns a non-2xx Response when the storage GET on the ciphertext fails (object-absent path → AC-224)', async () => {
    // Per ui/project-detail.md §8.15.7 the operator remediation differs
    // between AC-244 (envelope unwrap fails) and AC-224 (storage 404 /
    // NoSuchKey). The SW returns a Response that drives the consumer
    // toward the right placeholder; the body code disambiguates.
    const dek = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
    installFetchPlan({
      downloadUrl: () =>
        jsonResponse({
          url: 'https://storage.example/c',
          expiresAt: '2026-04-30T12:00:00Z',
          dekMaterial: toBase64(dek),
        }),
      ciphertext: () => new Response('NoSuchKey', { status: 404 }),
    });

    const response = await handleEncryptedStorageRequest(
      syntheticRequest('p-42', 'att-1', 'original'),
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(404);
  });

  it('returns a non-2xx Response when the AES-GCM auth tag verification fails (tampered ciphertext)', async () => {
    // Cryptographic-integrity failure on the read path: the underlying
    // bytes returned a 200 from storage but they no longer match the
    // committed bytes. Per AC-243 / api.md §14.2.11 "two integrity
    // layers, two failure modes", the AES-GCM tag is the catch — the
    // SW must surface this as a fetch failure, not silently serve
    // garbled bytes (browser would then render a broken image / corrupt
    // PDF and confuse the user about which layer failed).
    const dek = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
    const plaintext = new TextEncoder().encode('original-bytes');
    const ciphertext = await encryptForTest(plaintext, dek);
    // Tamper with a byte inside the ciphertext region (not the nonce
    // prefix and not the tag) — AES-GCM detects any mutation.
    const tampered = ciphertext.slice();
    tampered[NONCE_BYTES + 1] ^= 0xff;

    installFetchPlan({
      downloadUrl: () =>
        jsonResponse({
          url: 'https://storage.example/c',
          expiresAt: '2026-04-30T12:00:00Z',
          dekMaterial: toBase64(dek),
        }),
      ciphertext: () => new Response(tampered.slice() as BlobPart),
    });

    const response = await handleEncryptedStorageRequest(
      syntheticRequest('p-42', 'att-1', 'original'),
    );

    expect(response.ok).toBe(false);
  });
});
