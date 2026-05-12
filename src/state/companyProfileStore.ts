/**
 * Company-profile singleton state (ui/daten.md §8.11.4, ADR-0026).
 *
 * Owner-mutated only — no cross-session race worth wiring an SSE
 * subscription for. The Daten view's CompanyProfileSection drives both
 * `fetch()` (mount + post-save refresh) and `save()` (PUT).
 *
 * Session expiry is funnelled through the shared helper so the bounce-
 * to-login surface stays uniform across stores.
 */

import { create } from 'zustand';
import type { CompanyProfile } from '@/domain/invoice';
import { companyProfileApi, type CompanyProfileInput } from '@/api/client';
import { handleSessionExpired } from './sessionExpired';

/**
 * Result of `save`. `'ok'` — PUT committed, `data` refreshed.
 * `'validation'` — server returned a 422 (VALIDATION_ERROR or
 * COMPANY_PROFILE_REQUIRED); the caller may inspect `saveError` for the
 * server-supplied German copy and the optional `missingFields` for
 * field-level targeting. `'error'` — generic failure; the message lives
 * on `saveError`.
 */
export type SaveOutcome =
  | { status: 'ok' }
  | { status: 'validation'; missingFields: string[] }
  | { status: 'error' };

interface CompanyProfileState {
  data: CompanyProfile | null;
  loading: boolean;
  saveError: string | null;

  fetch: () => Promise<void>;
  save: (payload: CompanyProfileInput) => Promise<SaveOutcome>;
  clearSaveError: () => void;
}

function extractMissingFields(details: unknown): string[] {
  if (details && typeof details === 'object' && 'missingFields' in details) {
    const value = (details as { missingFields: unknown }).missingFields;
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      return value;
    }
  }
  return [];
}

export const useCompanyProfileStore = create<CompanyProfileState>((set) => ({
  data: null,
  loading: false,
  saveError: null,

  fetch: async () => {
    set({ loading: true });
    const result = await companyProfileApi.get();
    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return;
      }
      set({ loading: false, saveError: result.error.message });
      return;
    }
    set({ data: result.data, loading: false });
  },

  save: async (payload) => {
    set({ saveError: null });
    const result = await companyProfileApi.put(payload);
    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return { status: 'error' };
      }
      const missingFields = extractMissingFields(result.details);
      set({ saveError: result.error.message });
      if (
        result.error.code === 'VALIDATION_ERROR' ||
        result.error.code === 'COMPANY_PROFILE_REQUIRED'
      ) {
        return { status: 'validation', missingFields };
      }
      return { status: 'error' };
    }
    set({ data: result.data });
    return { status: 'ok' };
  },

  clearSaveError: () => set({ saveError: null }),
}));
