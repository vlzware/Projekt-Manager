/**
 * Render a before/after field diff for an audit-row payload.
 *
 * The payload is typed as `unknown` on the API boundary because the
 * shape depends on the action and entity type (data-model.md §5.10).
 * Rendering is shape-tolerant: if the payload carries `before` /
 * `after` objects, the drawer emits a simple table; otherwise it
 * falls back to a pretty-printed JSON block (same information, just
 * less structured).
 */

import { STRINGS } from '@/config/strings';
import { isPayloadDiff } from '@/domain/audit';
import styles from './ActivityFeedRow.module.css';

interface Props {
  payload: unknown;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function PayloadDrawer({ payload }: Props) {
  if (!isPayloadDiff(payload)) {
    // Fallback: pretty JSON. Better than nothing and keeps the drawer
    // meaningful for payloads the UI has not specifically learned.
    const formatted = (() => {
      try {
        return JSON.stringify(payload, null, 2);
      } catch {
        return String(payload);
      }
    })();
    return (
      <pre className={styles.drawerValue} style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
        {formatted}
      </pre>
    );
  }

  const before = payload.before ?? {};
  const after = payload.after ?? {};
  const fieldKeys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));

  if (fieldKeys.length === 0) {
    return <span className={styles.drawerValueNull}>—</span>;
  }

  return (
    <table className={styles.drawerTable}>
      <thead>
        <tr>
          <th>{STRINGS.audit.drawerField}</th>
          <th>{STRINGS.audit.drawerBefore}</th>
          <th>{STRINGS.audit.drawerAfter}</th>
        </tr>
      </thead>
      <tbody>
        {fieldKeys.map((key) => {
          const beforeVal = (before as Record<string, unknown>)[key];
          const afterVal = (after as Record<string, unknown>)[key];
          const beforeIsNull = beforeVal === null || beforeVal === undefined;
          const afterIsNull = afterVal === null || afterVal === undefined;
          return (
            <tr key={key}>
              <td>{key}</td>
              <td className={beforeIsNull ? styles.drawerValueNull : styles.drawerValue}>
                {formatValue(beforeVal)}
              </td>
              <td className={afterIsNull ? styles.drawerValueNull : styles.drawerValue}>
                {formatValue(afterVal)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
