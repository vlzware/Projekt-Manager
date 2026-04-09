/**
 * API client tests — mocks `fetch` and verifies the apiCall wrapper:
 * success, network error, 401 + SESSION_EXPIRED detection, generic error,
 * malformed JSON, the typed projectApi/authApi request shapes AND return
 * values, and response-parsing edge cases (null body, 204, malformed JSON
 * on 2xx, structurally-wrong body).
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
      expect(result.error.code).toBe('SESSION_EXPIRED');
    }
  });

  it('does NOT mark sessionExpired for a 401 with a different code', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ code: 'INVALID_CREDENTIALS', message: 'Anmeldung fehlgeschlagen.' }, 401),
    );
    const result = await apiCall('/api/x');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.sessionExpired).toBe(false);
      expect(result.error.code).toBe('INVALID_CREDENTIALS');
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

    // Literal `null` is valid JSON; the client surfaces it as data=null with
    // ok=true. It does NOT throw. Callers must handle the null themselves.
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

    // 204 is a legitimate success. The body is null, res.json() throws (no
    // content to parse), and the `.catch(() => null)` branch in apiCall coerces
    // it to data=null. This keeps 204 from looking like an error to callers.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBeNull();
    }
  });

  it('swallows a malformed JSON body on a 2xx response and yields data=null', async () => {
    fetchMock.mockResolvedValue(new Response('not json{{{', { status: 200 }));

    const result = await apiCall('/api/x');

    // KNOWN BEHAVIOR: apiCall does `res.json().catch(() => null)` on success,
    // so a malformed body on a 2xx response becomes ok=true, data=null instead
    // of ok=false. A caller can't distinguish a genuine null payload from a
    // parse failure. This is a gap in the contract (see report C4), but this
    // test pins the current behavior so any future change is a deliberate one.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBeNull();
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
