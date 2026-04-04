import { format, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';

/**
 * Format an ISO date string to German DD.MM.YYYY format.
 */
export function formatDateDE(isoDate: string): string {
  return format(parseISO(isoDate), 'dd.MM.yyyy', { locale: de });
}

/**
 * Format an ISO date string to short German DD.MM. format.
 */
export function formatDateShortDE(isoDate: string): string {
  return format(parseISO(isoDate), 'dd.MM.', { locale: de });
}

/**
 * Format a date range for display. Uses short format for start if same year.
 */
export function formatDateRange(start?: string, end?: string): string {
  if (!start && !end) return 'Kein Termin';
  if (start && !end) return formatDateDE(start);
  if (start && end) {
    const startDate = parseISO(start);
    const endDate = parseISO(end);
    if (startDate.getFullYear() === endDate.getFullYear()) {
      return `${formatDateShortDE(start)} – ${formatDateDE(end)}`;
    }
    return `${formatDateDE(start)} – ${formatDateDE(end)}`;
  }
  return 'Kein Termin';
}

/**
 * Format a currency value in German locale.
 */
export function formatCurrencyDE(value: number): string {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: 'EUR',
  }).format(value);
}
