/**
 * Centralized API client.
 *
 * All HTTP communication with the backend goes through this module.
 * Handles: request construction, response parsing, session expiry detection,
 * and error normalization.
 *
 * The store layer calls these functions instead of raw fetch().
 */

export interface ApiError {
  code: string;
  message: string;
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiFailure {
  ok: false;
  error: ApiError;
  sessionExpired: boolean;
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
}

/**
 * Make an authenticated API call.
 * - Attaches correct headers and credentials
 * - Detects session expiry (401 + SESSION_EXPIRED code)
 * - Normalizes errors into a consistent shape
 * - Handles network failures gracefully
 */
export async function apiCall<T>(url: string, opts: RequestOptions = {}): Promise<ApiResult<T>> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      credentials: 'same-origin',
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    const isNetwork = err instanceof TypeError && /fetch|network/i.test(err.message);
    return {
      ok: false,
      error: {
        code: 'NETWORK_ERROR',
        message: isNetwork
          ? 'Netzwerkfehler. Bitte Verbindung überprüfen.'
          : 'Änderung fehlgeschlagen. Bitte erneut versuchen.',
      },
      sessionExpired: false,
    };
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({ code: 'UNKNOWN', message: '' }));

    if (res.status === 401 && data.code === 'SESSION_EXPIRED') {
      return {
        ok: false,
        error: { code: data.code, message: data.message ?? 'Sitzung abgelaufen.' },
        sessionExpired: true,
      };
    }

    return {
      ok: false,
      error: {
        code: data.code ?? 'API_ERROR',
        message: data.message ?? 'Änderung fehlgeschlagen. Bitte erneut versuchen.',
      },
      sessionExpired: false,
    };
  }

  // Success path.
  //
  // We distinguish three cases that previously all collapsed to `data=null`:
  //   1. 204 No Content (or explicit Content-Length: 0) — legitimately empty.
  //      res.json() would throw; short-circuit to `{ ok: true, data: null }`.
  //   2. 2xx with a JSON body that parses — return the parsed value, including
  //      a literal `null` payload (JSON.parse("null") is valid JSON).
  //   3. 2xx with a body that FAILS to parse — this is an error, not success.
  //      Surface it as ok=false with code INVALID_RESPONSE so callers can
  //      distinguish a malformed response from a legitimately null payload.
  if (res.status === 204 || res.headers.get('Content-Length') === '0') {
    return { ok: true, data: null as T };
  }

  try {
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch {
    return {
      ok: false,
      error: {
        code: 'INVALID_RESPONSE',
        message: 'Server returned malformed JSON',
      },
      sessionExpired: false,
    };
  }
}

// --- Typed API functions -----------------------------------------------------

import type { Project } from '@/domain/types';

interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  roles: string[];
  email: string | null;
}

interface LoginResponse {
  user: AuthUser;
}

interface ProjectListResponse {
  data: Project[];
  total: number;
}

export const authApi = {
  login: (username: string, password: string) =>
    apiCall<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: { username, password },
    }),

  logout: () => apiCall<{ success: boolean }>('/api/auth/logout', { method: 'POST' }),

  me: () => apiCall<AuthUser>('/api/auth/me'),
};

export const projectApi = {
  list: () => apiCall<ProjectListResponse>('/api/projects'),

  get: (id: string) => apiCall<Project>(`/api/projects/${id}`),

  transitionForward: (id: string) =>
    apiCall<Project>(`/api/projects/${id}/transition/forward`, { method: 'POST' }),

  transitionBackward: (id: string) =>
    apiCall<Project>(`/api/projects/${id}/transition/backward`, { method: 'POST' }),

  updateDates: (id: string, dates: { plannedStart?: string | null; plannedEnd?: string | null }) =>
    apiCall<Project>(`/api/projects/${id}/dates`, {
      method: 'PATCH',
      body: dates,
    }),
};

export type { AuthUser };
