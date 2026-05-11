/**
 * Sortable table-header cell. Renders a `<th>` whose label is wrapped in
 * a button; clicking cycles asc → desc → asc on the active column, and
 * activating a different column resets direction to ascending. The
 * `aria-sort` attribute is set on the `<th>` per WAI-ARIA practice so
 * screen readers announce the current sort state.
 *
 * Generic in the column-key type so each consumer (Kunden / Projekte)
 * gets its own narrow allowlist enforced at the call site.
 */

import type { ReactNode } from 'react';
import styles from './SortableHeader.module.css';

export type SortDirection = 'asc' | 'desc';

export interface SortableHeaderProps<C extends string> {
  /** Stable column key sent to the API as `sortBy`. */
  column: C;
  /** Currently active sort column, or null when no sort is applied. */
  activeColumn: C | null;
  /** Direction of the active sort. Ignored when `activeColumn !== column`. */
  direction: SortDirection;
  /** Called with the next sort state when the user activates this header. */
  onSort: (column: C, direction: SortDirection) => void;
  /** Visible header label. */
  children: ReactNode;
  /** Optional test id forwarded to the underlying button. */
  testId?: string;
}

export function SortableHeader<C extends string>({
  column,
  activeColumn,
  direction,
  onSort,
  children,
  testId,
}: SortableHeaderProps<C>) {
  const isActive = activeColumn === column;
  const ariaSort: 'ascending' | 'descending' | 'none' = isActive
    ? direction === 'asc'
      ? 'ascending'
      : 'descending'
    : 'none';

  const handleClick = () => {
    if (!isActive) {
      onSort(column, 'asc');
      return;
    }
    onSort(column, direction === 'asc' ? 'desc' : 'asc');
  };

  // The arrow glyphs are decorative — the live aria-sort attribute on the
  // `<th>` carries the same information for assistive tech, so the icon
  // is marked aria-hidden to avoid duplicated announcements.
  const indicator = isActive ? (direction === 'asc' ? '▲' : '▼') : '↕';

  return (
    <th aria-sort={ariaSort} className={styles.header}>
      <button
        type="button"
        className={styles.button}
        onClick={handleClick}
        data-testid={testId}
        data-active={isActive ? 'true' : 'false'}
      >
        <span className={styles.label}>{children}</span>
        <span className={styles.indicator} aria-hidden="true">
          {indicator}
        </span>
      </button>
    </th>
  );
}
