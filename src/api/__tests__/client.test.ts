/**
 * API client tests — mocks `fetch` and verifies the apiCall wrapper:
 * success, network error, 401 + SESSION_EXPIRED detection, generic error,
 * malformed JSON, and the typed projectApi/authApi method shapes.
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

describe('projectApi — typed method shapes', () => {
  it('list calls GET /api/projects', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [], total: 0 }));
    await projectApi.list();
    expect(fetchMock).toHaveBeenCalledWith('/api/projects', expect.any(Object));
  });

  it('transitionForward POSTs to the right URL with no body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await projectApi.transitionForward('p123');
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/projects/p123/transition/forward');
    expect(opts.method).toBe('POST');
    expect(opts.body).toBeUndefined();
  });

  it('updateDates PATCHes the dates payload', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await projectApi.updateDates('p1', { plannedStart: '2026-05-01', plannedEnd: '2026-05-03' });
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/projects/p1/dates');
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body)).toEqual({
      plannedStart: '2026-05-01',
      plannedEnd: '2026-05-03',
    });
  });
});

describe('authApi — typed method shapes', () => {
  it('login POSTs username+password to /api/auth/login', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: { id: 'u1' } }));
    await authApi.login('alice', 'pw');
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/auth/login');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ username: 'alice', password: 'pw' });
  });

  it('me GETs /api/auth/me', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'u1' }));
    await authApi.me();
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/me', expect.any(Object));
  });

  it('logout POSTs /api/auth/logout', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));
    await authApi.logout();
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/auth/logout');
    expect(opts.method).toBe('POST');
  });
});
