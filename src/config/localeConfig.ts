import { de } from 'date-fns/locale';

/**
 * Locale configuration — centralized for future per-company customization.
 * Currently German-only. Changing locale requires updating this file.
 */
export const LOCALE = {
  dateFns: de,
  intlLocale: 'de-DE',
  currency: 'EUR',
} as const;
