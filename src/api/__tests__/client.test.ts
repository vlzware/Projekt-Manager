/**
 * API client tests — mocks `fetch` and verifies the apiCall wrapper:
 * success, network error, 401 + SESSION_EXPIRED detection, generic error,
 * the typed projectApi/authApi request shapes AND return values, and
 * response-parsing edge cases (literal JSON null, 204 No Content, malformed
 * JSON on 2xx → INVALID_RESPONSE, structurally-wrong body).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { apiCall, projectApi, authApi } from '@/api/client';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('apiCall — happy path', () => {
  it('returns ok=true with parsed data on a 200 response', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ hello: 'world' }));
    const result = await apiCall<{ hello: string }>('/api/whatever');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ hello: 'world' });
  });

  it('serializes the body as JSON for POST requests', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await apiCall('/api/x', { method: 'POST', body: { a: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, opts] = fetchMock.mock.calls[0]!;
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(opts.body).toBe(JSON.stringify({ a: 1 }));
    expect(opts.credentials).toBe('same-origin');
  });

  it('omits the Content-Type header when no body is sent', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await apiCall('/api/x');
    const [, opts] = fetchMock.mock.calls[0]!;
    expect(opts.headers['Content-Type']).toBeUndefined();
    expect(opts.body).toBeUndefined();
  });
});

describe('apiCall — error paths', () => {
  it('returns NETWORK_ERROR for fetch rejection (TypeError)', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await apiCall('/api/x');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NETWORK_ERROR');
      expect(result.error.message).toMatch(/Netzwerk/);
      expect(result.sessionExpired).toBe(false);
    }
  });

  it('detects SESSION_EXPIRED on a 401 response with the matching code', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ code: 'SESSION_EXPIRED', message: 'Sitzung abgelaufen.' }, 401),
    );
    const result = await apiCall('/api/x');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.sessionExpired).toBe(true);
      expect(result.category).toBe('authentication');
      expect(result.error.code).toBe('SESSION_EXPIRED');
    }
  });

  it('treats UNAUTHENTICATED the same as SESSION_EXPIRED for routing', async () => {
    // Before H-3, only SESSION_EXPIRED flagged sessionExpired=true. A
    // protected request with no cookie at all returns UNAUTHENTICATED and
    // must also redirect to login — otherwise the user sees a stale page
    // with a generic "mutation failed" banner instead of being bounced.
    // api.md §14.4.1: "authentication error: credentials invalid, session
    // expired, or session absent → redirect to login".
    fetchMock.mockResolvedValue(
      jsonResponse({ code: 'UNAUTHENTICATED', message: 'Nicht angemeldet.' }, 401),
    );
    const result = await apiCall('/api/x');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.sessionExpired).toBe(true);
      expect(result.category).toBe('authentication');
      expect(result.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('does NOT mark sessionExpired for INVALID_CREDENTIALS (still authentication category)', async () => {
    // INVALID_CREDENTIALS is only ever thrown at the login screen itself,
    // where the user is already at "login" — a redirect would be a no-op.
    // The category is still `authentication` so the store can classify it
    // correctly, but sessionExpired stays false so no redirect fires.
    fetchMock.mockResolvedValue(
      jsonResponse({ code: 'INVALID_CREDENTIALS', message: 'Anmeldung fehlgeschlagen.' }, 401),
    );
    const result = await apiCall('/api/x');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.sessionExpired).toBe(false);
      expect(result.category).toBe('authentication');
      expect(result.error.code).toBe('INVALID_CREDENTIALS');
    }
  });

  it('classifies NOT_FOUND as not_found category', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ code: 'NOT_FOUND', message: 'Projekt nicht gefunden.' }, 404),
    );
    const result = await apiCall('/api/x');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.category).toBe('not_found');
      expect(result.sessionExpired).toBe(false);
    }
  });

  it('classifies NOT_PERMITTED as authorization category', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ code: 'NOT_PERMITTED', message: 'Keine Berechtigung.' }, 403),
    );
    const result = await apiCall('/api/x');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.category).toBe('authorization');
      expect(result.sessionExpired).toBe(false);
      expect(result.error.message).toBe('Keine Berechtigung.');
    }
  });

  it('classifies VALIDATION_ERROR as validation category', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ code: 'VALIDATION_ERROR', message: 'Ungültig.' }, 422),
    );
    const result = await apiCall('/api/x');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.category).toBe('validation');
      expect(result.sessionExpired).toBe(false);
    }
  });

  it('classifies RATE_LIMITED as rate_limited and falls back to the canonical German message', async () => {
    // Intentionally omit a message on the server side to exercise the
    // fallback — simulates a reverse-proxy intercept that returns a
    // bare { code } body. The client must still show a user-ready
    // German message and never an empty string or a raw code.
    fetchMock.mockResolvedValue(jsonResponse({ code: 'RATE_LIMITED' }, 429));
    const result = await apiCall('/api/x');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.category).toBe('rate_limited');
      expect(result.error.message).toBe('Zu viele Anfragen. Bitte später erneut versuchen.');
      expect(result.sessionExpired).toBe(false);
    }
  });

  it('classifies SERVER_ERROR as server_error and falls back to the canonical German message', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 'SERVER_ERROR' }, 500));
    const result = await apiCall('/api/x');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.category).toBe('server_error');
      expect(result.error.message).toBe('Ein interner Fehler ist aufgetreten.');
    }
  });

  it('classifies an unknown code as server_error (fail-safe default)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ code: 'SOMETHING_BRAND_NEW', message: 'whatever' }, 500),
    );
    const result = await apiCall('/api/x');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.category).toBe('server_error');
      expect(result.error.code).toBe('SOMETHING_BRAND_NEW');
    }
  });

  it('normalizes a non-2xx response with code+message into ApiFailure', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ code: 'VALIDATION_ERROR', message: 'Ungültig.' }, 422),
    );
    const result = await apiCall('/api/x');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
      expect(result.error.message).toBe('Ungültig.');
      expect(result.sessionExpired).toBe(false);
    }
  });

  it('uses UNKNOWN when the error response body is not parseable JSON', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 500 }));
    const result = await apiCall('/api/x');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The client falls back to { code: 'UNKNOWN', message: '' } when
      // res.json() throws — this is what propagates through the error envelope.
      expect(result.error.code).toBe('UNKNOWN');
    }
  });

  it('falls back to API_ERROR when the parsed body has no code field', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Boom' }, 500));
    const result = await apiCall('/api/x');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('API_ERROR');
      expect(result.error.message).toBe('Boom');
    }
  });
});

describe('projectApi — request shape and return value', () => {
  it('list returns the parsed { data, total } body on success', async () => {
    const payload = {
      data: [
        { id: 'p1', number: '2026-001', title: 'Dach Müller', status: 'anfrage' },
        { id: 'p2', number: '2026-002', title: 'Bad Schmidt', status: 'angebot' },
      ],
      total: 2,
    };
    fetchMock.mockResolvedValue(jsonResponse(payload));

    const result = await projectApi.list();

    // Keep the request-shape assertion (cheap routing typo check).
    expect(fetchMock).toHaveBeenCalledWith('/api/projects', expect.any(Object));
    // And assert on the returned value — this is the part that used to be missing.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.total).toBe(2);
      expect(result.data.data).toHaveLength(2);
      expect(result.data.data[0]!.id).toBe('p1');
      expect(result.data.data[1]!.status).toBe('angebot');
    }
  });

  it('get returns the parsed project body on success', async () => {
    const project = { id: 'p7', number: '2026-007', title: 'Küche Weber', status: 'auftrag' };
    fetchMock.mockResolvedValue(jsonResponse(project));

    const result = await projectApi.get('p7');

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p7', expect.any(Object));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe('p7');
      expect(result.data.status).toBe('auftrag');
    }
  });

  it('get propagates an ApiFailure when the server returns a non-2xx', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ code: 'NOT_FOUND', message: 'Projekt nicht gefunden.' }, 404),
    );

    const result = await projectApi.get('missing');

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/missing', expect.any(Object));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NOT_FOUND');
      expect(result.error.message).toBe('Projekt nicht gefunden.');
      expect(result.sessionExpired).toBe(false);
    }
  });

  it('transitionForward POSTs with no body and returns the updated project', async () => {
    const updated = { id: 'p123', number: '2026-123', title: 'X', status: 'angebot' };
    fetchMock.mockResolvedValue(jsonResponse(updated));

    const result = await projectApi.transitionForward('p123');

    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/projects/p123/transition/forward');
    expect(opts.method).toBe('POST');
    expect(opts.body).toBeUndefined();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe('p123');
      expect(result.data.status).toBe('angebot');
    }
  });

  it('transitionBackward POSTs to the backward URL and returns the updated project', async () => {
    const updated = { id: 'p9', number: '2026-009', title: 'Y', status: 'anfrage' };
    fetchMock.mockResolvedValue(jsonResponse(updated));

    const result = await projectApi.transitionBackward('p9');

    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/projects/p9/transition/backward');
    expect(opts.method).toBe('POST');
    expect(opts.body).toBeUndefined();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe('anfrage');
    }
  });

  it('updateDates PATCHes the dates payload and returns the updated project', async () => {
    const updated = {
      id: 'p1',
      number: '2026-001',
      title: 'Z',
      status: 'auftrag',
      plannedStart: '2026-05-01',
      plannedEnd: '2026-05-03',
    };
    fetchMock.mockResolvedValue(jsonResponse(updated));

    const result = await projectApi.updateDates('p1', {
      plannedStart: '2026-05-01',
      plannedEnd: '2026-05-03',
    });

    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/projects/p1/dates');
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body)).toEqual({
      plannedStart: '2026-05-01',
      plannedEnd: '2026-05-03',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe('p1');
      expect(result.data.plannedStart).toBe('2026-05-01');
      expect(result.data.plannedEnd).toBe('2026-05-03');
    }
  });
});

describe('authApi — request shape and return value', () => {
  it('login POSTs credentials and returns the user from the response body', async () => {
    const payload = {
      user: {
        id: 'u1',
        username: 'alice',
        displayName: 'Alice',
        roles: ['admin'],
        email: 'alice@example.test',
      },
    };
    fetchMock.mockResolvedValue(jsonResponse(payload));

    const result = await authApi.login('alice', 'pw');

    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/auth/login');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ username: 'alice', password: 'pw' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.user.id).toBe('u1');
      expect(result.data.user.username).toBe('alice');
      expect(result.data.user.roles).toEqual(['admin']);
    }
  });

  it('login propagates INVALID_CREDENTIALS as an ApiFailure', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ code: 'INVALID_CREDENTIALS', message: 'Anmeldung fehlgeschlagen.' }, 401),
    );

    const result = await authApi.login('alice', 'wrong');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_CREDENTIALS');
      // A 401 with a non-SESSION_EXPIRED code must NOT be flagged as a session expiry.
      expect(result.sessionExpired).toBe(false);
    }
  });

  it('me GETs /api/auth/me and returns the user directly', async () => {
    const user = {
      id: 'u1',
      username: 'alice',
      displayName: 'Alice',
      roles: ['user'],
      email: null,
    };
    fetchMock.mockResolvedValue(jsonResponse(user));

    const result = await authApi.me();

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/me', expect.any(Object));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe('u1');
      expect(result.data.email).toBeNull();
      expect(result.data.roles).toEqual(['user']);
    }
  });

  it('logout POSTs /api/auth/logout and returns the success flag', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));

    const result = await authApi.logout();

    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/auth/logout');
    expect(opts.method).toBe('POST');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.success).toBe(true);
    }
  });
});

describe('apiCall — response parsing edge cases', () => {
  /**
   * These tests pin down how apiCall handles weird-but-possible response bodies.
   * The client does NOT validate response shape — it parses JSON and hands the
   * result to the caller. Upstream consumers must treat the returned `data` as
   * untrusted. These tests document that contract.
   */

  it('returns ok=true with data=null when the response body is literal JSON null', async () => {
    fetchMock.mockResolvedValue(jsonResponse(null));

    const result = await apiCall('/api/x');

    // Literal `null` is valid JSON; JSON.parse("null") succeeds and returns
    // null, so this is a successful parse that happens to yield null — NOT
    // the INVALID_RESPONSE path. This is distinct from the malformed-body
    // case above, which is the whole point of the C4 fix.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBeNull();
    }
  });

  it('returns ok=true with data=null for a 204 No Content response', async () => {
    // Per the Fetch spec, a 204 response has a null body. `new Response(null,
    // { status: 204 })` is the only legal way to build one — passing the empty
    // string throws "Invalid response status code 204" in jsdom/undici.
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    const result = await apiCall('/api/x');

    // 204 is a legitimate success. apiCall short-circuits on status===204
    // BEFORE calling res.json(), so this never goes through the malformed-body
    // branch — which is the whole point of the C4 fix: a 204 and a malformed
    // 2xx body no longer collapse into the same result.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBeNull();
    }
  });

  it('treats a 204 as empty even if a non-empty body slips through', async () => {
    // Defensive: some stacks (or buggy mocks) will produce a 204 with a body
    // attached. The Fetch spec says the UA must strip it, but we do not rely
    // on that. Our short-circuit on status===204 fires before res.json() runs,
    // so even garbage bytes on a 204 are ignored — NOT surfaced as
    // INVALID_RESPONSE. This keeps the malformed-body branch distinct from
    // the legitimate-empty-success branch.
    const res = new Response('garbage{{{', { status: 200 });
    // Mutate status to 204 after construction so `new Response` does not
    // reject the non-null body. (This is the shape a buggy server/mock could
    // produce in practice.)
    Object.defineProperty(res, 'status', { value: 204, configurable: true });
    fetchMock.mockResolvedValue(res);

    const result = await apiCall('/api/x');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBeNull();
    }
  });

  it('surfaces INVALID_RESPONSE when a 2xx response has a malformed JSON body', async () => {
    fetchMock.mockResolvedValue(new Response('not json{{{', { status: 200 }));

    const result = await apiCall('/api/x');

    // A malformed body on a 2xx response is an ERROR, not a null payload.
    // Callers need to distinguish "server sent garbage" from "server sent a
    // legitimately null payload" — the latter is a separate code path below
    // (literal JSON null, 204 No Content). See the C4 fix for the rationale.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_RESPONSE');
      expect(result.error.message).toBe('Server-Antwort ungültig. Bitte erneut versuchen.');
      expect(result.sessionExpired).toBe(false);
    }
  });

  it('falls back to UNKNOWN on a non-2xx response with a malformed JSON body', async () => {
    fetchMock.mockResolvedValue(new Response('not json{{{', { status: 500 }));

    const result = await apiCall('/api/x');

    // On the error path, the `.catch(() => ({ code: 'UNKNOWN', message: '' }))`
    // fallback kicks in, then the code normalization in apiCall leaves
    // error.code as 'UNKNOWN' (not 'API_ERROR' — the fallback object already
    // supplies a code).
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNKNOWN');
      expect(result.sessionExpired).toBe(false);
    }
  });

  it('passes through a structurally-wrong response body without runtime validation', async () => {
    // TypeScript says projectApi.list() returns { data: Project[]; total: number }.
    // The runtime does NOT enforce that. If the server returns data="oops", the
    // client hands it back verbatim. This documents the contract: "apiCall does
    // not validate response shape; consumers must."
    const badPayload = { data: 'oops', total: 'also oops' };
    fetchMock.mockResolvedValue(jsonResponse(badPayload));

    const result = await projectApi.list();

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The cast to ProjectListResponse is a lie at runtime — cast through
      // `unknown` so the assertion compiles while still verifying the raw
      // payload passed through unchanged.
      const raw = result.data as unknown as { data: string; total: string };
      expect(raw.data).toBe('oops');
      expect(raw.total).toBe('also oops');
    }
  });
});
