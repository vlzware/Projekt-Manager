/**
 * Centralized API client.
 *
 * All HTTP communication with the backend goes through this module.
 * Handles: request construction, response parsing, session expiry detection,
 * and error normalization.
 *
 * The store layer calls these functions instead of raw fetch().
 */

import { STRINGS } from '@/config/strings';
import type { ThemePreference } from '@/config/themeStorage';

export interface ApiError {
  code: string;
  message: string;
}

/**
 * Error categories from `docs/spec/api.md §14.4.1`. The client classifies
 * every failure into one of these so the state/UI layers can branch on
 * category rather than on individual error codes. This closes the gap
 * where only SESSION_EXPIRED was handled specially and every other code
 * collapsed into the same generic path. See consolidation review H-3 / E F-1.
 */
export type ErrorCategory =
  | 'authentication' // INVALID_CREDENTIALS, UNAUTHENTICATED, SESSION_EXPIRED
  | 'authorization' // NOT_PERMITTED
  | 'validation' // VALIDATION_ERROR
  | 'not_found' // NOT_FOUND
  | 'rate_limited' // RATE_LIMITED
  | 'server_error' // SERVER_ERROR, unknown server codes
  | 'network' // NETWORK_ERROR (client-side, fetch rejection)
  | 'invalid_response'; // INVALID_RESPONSE (client-side, malformed 2xx body)

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiFailure {
  ok: false;
  error: ApiError;
  category: ErrorCategory;
  /**
   * True iff the failure indicates the user must return to the login
   * screen — `SESSION_EXPIRED` (the session existed but aged out) or
   * `UNAUTHENTICATED` (no cookie at all on a protected endpoint). The
   * `INVALID_CREDENTIALS` sub-case of authentication is NOT included
   * because it only reaches the client from the login screen itself,
   * where a redirect would be a no-op.
   */
  sessionExpired: boolean;
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

function classifyCode(code: string): ErrorCategory {
  switch (code) {
    case 'INVALID_CREDENTIALS':
    case 'UNAUTHENTICATED':
    case 'SESSION_EXPIRED':
      return 'authentication';
    case 'NOT_PERMITTED':
      return 'authorization';
    case 'VALIDATION_ERROR':
      return 'validation';
    case 'NOT_FOUND':
      return 'not_found';
    case 'RATE_LIMITED':
      return 'rate_limited';
    case 'NETWORK_ERROR':
      return 'network';
    case 'INVALID_RESPONSE':
      return 'invalid_response';
    case 'SERVER_ERROR':
    default:
      // Unknown codes fall into server_error so the UI shows a generic
      // message — never leak an unknown-code string to the user.
      return 'server_error';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /**
   * Optional `AbortSignal`. When fired mid-flight the fetch rejects
   * with an `AbortError`; the rejection is caught below and returned
   * as a `network`-category ApiResult so callers see a consistent
   * shape. Transport-level cancellation; no UI side effects here.
   */
  signal?: AbortSignal;
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
      signal: opts.signal,
    });
  } catch (err) {
    const isNetwork = err instanceof TypeError && /fetch|network/i.test(err.message);
    return {
      ok: false,
      error: {
        code: 'NETWORK_ERROR',
        message: isNetwork ? STRINGS.errors.networkError : STRINGS.errors.mutationFailed,
      },
      category: 'network',
      sessionExpired: false,
    };
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({ code: 'UNKNOWN', message: '' }));
    const rawCode = (data.code as string | undefined) ?? 'API_ERROR';
    const category = classifyCode(rawCode);

    // Authentication-category with a *pre-existing* session context
    // (SESSION_EXPIRED or UNAUTHENTICATED) means the user must be bounced
    // to the login screen. INVALID_CREDENTIALS is authentication-category
    // but only reaches the client from the login screen itself, so we
    // deliberately do NOT flag it as sessionExpired.
    const sessionExpired = rawCode === 'SESSION_EXPIRED' || rawCode === 'UNAUTHENTICATED';

    // Rate-limited and generic server errors get the canonical German
    // message from strings.ts if the server didn't supply one — the
    // handlers above try to always supply one, but a reverse-proxy
    // intercept (e.g., Caddy returning an HTML 503) might not. Never
    // show the user a raw code or an empty string.
    let fallbackMessage: string = STRINGS.errors.mutationFailed;
    if (category === 'rate_limited') fallbackMessage = STRINGS.errors.rateLimited;
    else if (category === 'server_error') fallbackMessage = STRINGS.errors.serverError;
    else if (sessionExpired) fallbackMessage = STRINGS.auth.sessionExpired;
    else if (category === 'authorization') fallbackMessage = STRINGS.auth.notPermitted;

    return {
      ok: false,
      error: {
        code: rawCode,
        message: (data.message as string | undefined) || fallbackMessage,
      },
      category,
      sessionExpired,
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
        message: STRINGS.errors.invalidResponse,
      },
      category: 'invalid_response',
      sessionExpired: false,
    };
  }
}

// --- Typed API functions -----------------------------------------------------

import type { Project, Customer, User, Attachment, AttachmentLabel } from '@/domain/types';
import type { WorkflowState } from '@/config/stateConfig';
import type { Envelope, DryRunPreview, ImportResult } from '@/domain/dataExchange';
import type { BackupStatus } from '@/domain/backupBadge';
import type { AuditEntry, AuditListParams, AuditListResponse } from '@/domain/audit';
import type { NotificationRule, NotificationRuleInput } from '@/domain/notifications';

interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  roles: string[];
  email: string | null;
  themePreference: ThemePreference;
  /**
   * Server-authoritative push-mute flag (data-model.md §5.3). When true,
   * the dispatcher skips every subscription the user owns but the row is
   * retained — unmuting restores delivery without a re-subscribe.
   * Updated via the self-update API (§14.2.1).
   */
  pushMuted: boolean;
}

/**
 * Response envelope for /api/auth/login and /api/auth/me.
 *
 * The server includes `backupStatus` only when the caller holds the
 * `owner` role (api.md §14.2.1, verification.md AC-170). Other roles
 * get an envelope without the key — absence drives the UI's "no badge
 * on this surface" branch without requiring a separate role check.
 */
interface LoginResponse {
  user: AuthUser;
  backupStatus?: BackupStatus;
}

/** Response shape for the public GET /api/backup/status surface. */
export type BackupStatusResponse = { available: true; status: BackupStatus } | { available: false };

interface ProjectListResponse {
  data: Project[];
  total: number;
}

interface CustomerListResponse {
  customers: Customer[];
  total: number;
}

interface UserListResponse {
  users: User[];
  total: number;
}

/** Build a query string from an object, skipping undefined values. */
function toQuery(params?: Record<string, string | number | boolean | undefined>): string {
  if (!params) return '';
  const entries = Object.entries(params).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '';
  return '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

export const authApi = {
  login: (username: string, password: string) =>
    apiCall<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: { username, password },
    }),

  logout: () => apiCall<{ success: boolean }>('/api/auth/logout', { method: 'POST' }),

  me: () => apiCall<LoginResponse>('/api/auth/me'),

  changePassword: (currentPassword: string, newPassword: string) =>
    apiCall<{ success: boolean }>('/api/auth/change-password', {
      method: 'POST',
      body: { currentPassword, newPassword },
    }),

  updateSelf: (patch: { themePreference?: ThemePreference; pushMuted?: boolean }) =>
    apiCall<LoginResponse>('/api/auth/me', { method: 'PATCH', body: patch }),
};

export const projectApi = {
  list: (params?: {
    status?: string;
    search?: string;
    customerId?: string;
    hasNoDates?: boolean;
    includeArchived?: boolean;
  }) =>
    apiCall<ProjectListResponse>(
      '/api/projects' + toQuery(params as Record<string, string | number | boolean | undefined>),
    ),

  get: (id: string) => apiCall<Project>(`/api/projects/${id}`),

  create: (data: {
    id?: string;
    number: string;
    title: string;
    customerId: string;
    status?: string;
    plannedStart?: string | null;
    plannedEnd?: string | null;
    assignedWorkerIds?: string[];
    estimatedValue?: number | null;
    notes?: string | null;
  }) => apiCall<Project>('/api/projects', { method: 'POST', body: data }),

  update: (
    id: string,
    data: {
      title?: string;
      customerId?: string;
      assignedWorkerIds?: string[];
      estimatedValue?: number | null;
      notes?: string | null;
    },
  ) => apiCall<Project>(`/api/projects/${id}`, { method: 'PATCH', body: data }),

  delete: (id: string) =>
    apiCall<{ success: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),

  /**
   * Hard-delete an already-archived project. 204 on success. A
   * non-archived target returns 409 CONFLICT with German copy
   * directing the user to archive first; a non-existent target
   * returns 404 NOT_FOUND. Requires `project:purge` (owner-only).
   */
  purge: (id: string) => apiCall<null>(`/api/projects/${id}/purge`, { method: 'DELETE' }),

  transitionForward: (id: string, expectedStatus: WorkflowState) =>
    apiCall<Project>(`/api/projects/${id}/transition/forward`, {
      method: 'POST',
      body: { expectedStatus },
    }),

  transitionBackward: (id: string, expectedStatus: WorkflowState) =>
    apiCall<Project>(`/api/projects/${id}/transition/backward`, {
      method: 'POST',
      body: { expectedStatus },
    }),

  updateDates: (id: string, dates: { plannedStart?: string | null; plannedEnd?: string | null }) =>
    apiCall<Project>(`/api/projects/${id}/dates`, {
      method: 'PATCH',
      body: dates,
    }),
};

export const customerApi = {
  list: (params?: { offset?: number; limit?: number; search?: string }) =>
    apiCall<CustomerListResponse>(
      '/api/customers' + toQuery(params as Record<string, string | number | boolean | undefined>),
    ),

  get: (id: string) =>
    apiCall<Customer & { projectCount: number; archivedProjectCount: number }>(
      `/api/customers/${id}`,
    ),

  create: (data: {
    id?: string;
    name: string;
    phone?: string | null;
    email?: string | null;
    address?: { street: string; zip: string; city: string } | null;
    notes?: string | null;
  }) => apiCall<Customer>('/api/customers', { method: 'POST', body: data }),

  update: (
    id: string,
    data: {
      name?: string;
      phone?: string | null;
      email?: string | null;
      address?: { street: string; zip: string; city: string } | null;
      notes?: string | null;
    },
  ) => apiCall<Customer>(`/api/customers/${id}`, { method: 'PATCH', body: data }),

  delete: (id: string) =>
    apiCall<{ success: boolean }>(`/api/customers/${id}`, { method: 'DELETE' }),
};

export const userApi = {
  list: (params?: { offset?: number; limit?: number }) =>
    apiCall<UserListResponse>(
      '/api/users' + toQuery(params as Record<string, string | number | boolean | undefined>),
    ),

  get: (id: string) => apiCall<User>(`/api/users/${id}`),

  create: (data: {
    username: string;
    displayName: string;
    password: string;
    roles: string[];
    email?: string | null;
  }) => apiCall<User>('/api/users', { method: 'POST', body: data }),

  update: (
    id: string,
    data: {
      displayName?: string;
      roles?: string[];
      email?: string | null;
    },
  ) => apiCall<User>(`/api/users/${id}`, { method: 'PATCH', body: data }),

  deactivate: (id: string) => apiCall<User>(`/api/users/${id}/deactivate`, { method: 'POST' }),

  reactivate: (id: string) => apiCall<User>(`/api/users/${id}/reactivate`, { method: 'POST' }),

  delete: (id: string) => apiCall<void>(`/api/users/${id}`, { method: 'DELETE' }),

  resetPassword: (id: string, newPassword: string) =>
    apiCall<{ success: boolean }>(`/api/users/${id}/reset-password`, {
      method: 'POST',
      body: { newPassword },
    }),
};

/**
 * Unified business-data export/import (ADR-0018, api.md §14.2.4).
 *
 * Export is GET /api/export (permission: data:export).
 * Import is POST /api/import?dry_run=&override= (permission: data:restore).
 * The dry-run response is a DryRunPreview; the non-dry response is an
 * ImportResult. The caller disambiguates via the `dryRun` option.
 */
export const dataApi = {
  export: () => apiCall<Envelope>('/api/export'),

  import: (
    envelope: Envelope,
    opts: { dryRun: boolean; override: boolean; confirmationPhrase?: string | null },
  ) => {
    const params = new URLSearchParams();
    if (opts.dryRun) params.set('dry_run', 'true');
    if (opts.override) params.set('override', 'true');
    const qs = params.toString();
    const body =
      opts.confirmationPhrase != null
        ? { ...envelope, confirmation_phrase: opts.confirmationPhrase }
        : envelope;
    return apiCall<ImportResult | DryRunPreview>('/api/import' + (qs ? '?' + qs : ''), {
      method: 'POST',
      body,
    });
  },
};

export interface ExtractionResult {
  customer: {
    name: string | null;
    phone: string | null;
    email: string | null;
    street: string | null;
    zip: string | null;
    city: string | null;
  };
  project: {
    title: string | null;
    description: string | null;
  };
}

export const extractApi = {
  extract: (text: string) =>
    apiCall<ExtractionResult>('/api/extract', { method: 'POST', body: { text } }),
};

/**
 * Audit read surface (api.md §14.2.8).
 *
 * Read-only: `list` and `get` only. The per-role response shaping and
 * scope filtering happen server-side; the client receives the already-
 * redacted entries.
 */
export const auditApi = {
  list: (params?: AuditListParams) =>
    apiCall<AuditListResponse>(
      '/api/audit' + toQuery(params as Record<string, string | number | boolean | undefined>),
    ),

  get: (id: string) => apiCall<AuditEntry>(`/api/audit/${id}`),
};

interface NotificationRuleListResponse {
  data: NotificationRule[];
  total: number;
}

/**
 * Notification rules CRUD (api.md §14.2.9). Every endpoint is admin-only
 * and gated server-side by `notifications:manage`; the UI layer mirrors
 * the gate via `usePermission('notifications:manage')` for nav + surface
 * hiding only.
 */
export const notificationRuleApi = {
  list: () => apiCall<NotificationRuleListResponse>('/api/notification-rules'),

  get: (id: string) => apiCall<NotificationRule>(`/api/notification-rules/${id}`),

  create: (data: NotificationRuleInput) =>
    apiCall<NotificationRule>('/api/notification-rules', { method: 'POST', body: data }),

  update: (id: string, data: Partial<NotificationRuleInput>) =>
    apiCall<NotificationRule>(`/api/notification-rules/${id}`, { method: 'PATCH', body: data }),

  delete: (id: string) => apiCall<null>(`/api/notification-rules/${id}`, { method: 'DELETE' }),
};

/**
 * Public backup-status endpoint — no authentication required.
 *
 * Rendered on the login screen for operator visibility when the app
 * DB is also down (ADR-0008 VPN-gate is the threat-model anchor, see
 * api.md §14.2.7). The authenticated `/api/auth/me` flow carries the
 * same status as an embedded `backupStatus` field for owner callers,
 * so this endpoint is only consumed from the unauth login screen.
 */
export const backupApi = {
  status: () => apiCall<BackupStatusResponse>('/api/backup/status'),
};

/**
 * Server response for a subscribe call. The transport-only fields
 * (`p256dh`, `auth`) are never echoed back — they are stored server-
 * side and are opaque to the client after registration (see
 * data-model.md §5.12).
 */
export interface PushSubscriptionRecord {
  id: string;
  endpoint: string;
  createdAt: string;
}

/**
 * Push-subscription endpoints (api.md §14.2.10). Self-scope — the server
 * derives `userId` from the session, so the client never sends one.
 */
export const pushApi = {
  subscribe: (body: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    userAgent?: string | null;
  }) =>
    apiCall<PushSubscriptionRecord>('/api/push-subscriptions', {
      method: 'POST',
      body,
    }),

  unsubscribeByEndpoint: (endpoint: string) => {
    const qs = toQuery({ endpoint });
    return apiCall<null>('/api/push-subscriptions' + qs, { method: 'DELETE' });
  },
};

export interface PresignedPost {
  url: string;
  fields: Record<string, string>;
  expiresAt: string;
}

export interface AttachmentInitResponse {
  attachment: Attachment;
  originalUpload: PresignedPost;
  thumbnailUpload?: PresignedPost;
}

export interface AttachmentDownloadUrlResponse {
  url: string;
  expiresAt: string;
}

export interface AttachmentListResponse {
  data: Attachment[];
}

export const attachmentApi = {
  list: (projectId: string) =>
    apiCall<AttachmentListResponse>(`/api/projects/${projectId}/attachments`),

  initUpload: (
    projectId: string,
    input: {
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      label: AttachmentLabel;
      hasThumbnail: boolean;
    },
    signal?: AbortSignal,
  ) =>
    apiCall<AttachmentInitResponse>(`/api/projects/${projectId}/attachments/init`, {
      method: 'POST',
      body: input,
      signal,
    }),

  completeUpload: (projectId: string, attachmentId: string, signal?: AbortSignal) =>
    apiCall<Attachment>(`/api/projects/${projectId}/attachments/${attachmentId}/complete`, {
      method: 'POST',
      signal,
    }),

  delete: (projectId: string, attachmentId: string) =>
    apiCall<null>(`/api/projects/${projectId}/attachments/${attachmentId}`, {
      method: 'DELETE',
    }),

  downloadUrl: (projectId: string, attachmentId: string, variant: 'original' | 'thumbnail') =>
    apiCall<AttachmentDownloadUrlResponse>(
      `/api/projects/${projectId}/attachments/${attachmentId}/download-url` + toQuery({ variant }),
    ),

  bulkDownloadUrl: (projectId: string, attachmentIds: string[]) =>
    apiCall<AttachmentDownloadUrlResponse>(`/api/projects/${projectId}/attachments/bulk-download`, {
      method: 'POST',
      body: { attachmentIds },
    }),
};

export type { AuthUser };
