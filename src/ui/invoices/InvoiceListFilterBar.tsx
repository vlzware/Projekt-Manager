/**
 * Filter bar for the standalone /rechnungen view (ui/invoices.md §8.16.1).
 *
 * Three filters AND-compose: Jahr, Status, Suche. Server enforces the
 * same composition; the bar is a UX affordance over the wire contract.
 *
 * Search is debounced inside the parent view (250 ms) — the bar is a
 * controlled-input surface and emits raw onChange events.
 */

import { STRINGS } from '@/config/strings';
import type { InvoiceStatus } from '@/domain/invoice';
import styles from './InvoiceListView.module.css';

interface Props {
  years: readonly number[];
  year: number | null;
  status: InvoiceStatus | null;
  search: string;
  onYearChange: (year: number | null) => void;
  onStatusChange: (status: InvoiceStatus | null) => void;
  onSearchChange: (search: string) => void;
}

export function InvoiceListFilterBar({
  years,
  year,
  status,
  search,
  onYearChange,
  onStatusChange,
  onSearchChange,
}: Props) {
  return (
    <div className={styles.toolbar} data-testid="invoice-list-toolbar">
      <div className={styles.filterGroup}>
        <label className={styles.filterLabel} htmlFor="invoice-list-year">
          {STRINGS.invoices.filterYear}
        </label>
        <select
          id="invoice-list-year"
          className={styles.filterSelect}
          value={year ?? ''}
          onChange={(e) => onYearChange(e.target.value === '' ? null : Number(e.target.value))}
          data-testid="invoice-list-filter-year"
        >
          <option value="">{STRINGS.invoices.filterYearAll}</option>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.filterGroup}>
        <label className={styles.filterLabel} htmlFor="invoice-list-status">
          {STRINGS.invoices.filterStatus}
        </label>
        <select
          id="invoice-list-status"
          className={styles.filterSelect}
          value={status ?? ''}
          onChange={(e) =>
            onStatusChange(e.target.value === '' ? null : (e.target.value as InvoiceStatus))
          }
          data-testid="invoice-list-filter-status"
        >
          <option value="">{STRINGS.invoices.filterStatusAll}</option>
          <option value="draft">{STRINGS.invoices.statusDraft}</option>
          <option value="issued">{STRINGS.invoices.statusIssued}</option>
          <option value="cancelled">{STRINGS.invoices.statusCancelled}</option>
        </select>
      </div>
      <input
        type="search"
        className={styles.searchInput}
        placeholder={STRINGS.invoices.filterSearchPlaceholder}
        aria-label={STRINGS.invoices.filterSearchPlaceholder}
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        data-testid="invoice-list-filter-search"
      />
    </div>
  );
}
