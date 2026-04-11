import { format, parseISO } from 'date-fns';
import { LOCALE } from '@/config/localeConfig';
import { STRINGS } from '@/config/strings';

/**
 * Format an ISO date string to German DD.MM.YYYY format.
 */
export function formatDateDE(isoDate: string): string {
  return format(parseISO(isoDate), 'dd.MM.yyyy', { locale: LOCALE.dateFns });
}

/**
 * Format an ISO date string to short German DD.MM. format.
 */
export function formatDateShortDE(isoDate: string): string {
  return format(parseISO(isoDate), 'dd.MM.', { locale: LOCALE.dateFns });
}

/**
 * Format a date range for display. Uses short format for start if same year.
 */
export function formatDateRange(start?: string, end?: string): string {
  if (!start && !end) return STRINGS.projects.noDate;
  if (start && !end) return formatDateDE(start);
  if (start && end) {
    const startDate = parseISO(start);
    const endDate = parseISO(end);
    if (startDate.getFullYear() === endDate.getFullYear()) {
      return `${formatDateShortDE(start)} – ${formatDateDE(end)}`;
    }
    return `${formatDateDE(start)} – ${formatDateDE(end)}`;
  }
  return STRINGS.projects.noDate;
}

/**
 * Format a currency value in German locale. `null` and `undefined`
 * return an em-dash placeholder rather than falling through to
 * `Intl.NumberFormat.format(null)`, which would render a falsified
 * "0,00 €" and mislead the user — see consolidation review D F-8.
 * Callers should also gate the surrounding DOM on a real number
 * (belt-and-braces), but the return value here guarantees no zero
 * leaks through the format path even if the gate is missed.
 */
export function formatCurrencyDE(value: number | null | undefined): string {
  if (value == null) return '\u2014';
  return new Intl.NumberFormat(LOCALE.intlLocale, {
    style: 'currency',
    currency: LOCALE.currency,
  }).format(value);
}
