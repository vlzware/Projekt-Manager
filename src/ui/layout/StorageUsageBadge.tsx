/**
 * Footer storage badge (spec ui/index.md §8.1.2, AC-271).
 *
 * Surfaces the total visible plaintext footprint of project data to
 * `data:export` holders (owner / office). The hover tooltip carries the
 * two-bucket breakdown — `Sichtbar` (ready.plaintext) and
 * `Im Papierkorb` (hidden.plaintext). Ciphertext bytes are operator /
 * billing concerns and never reach this surface.
 *
 * Permission gate runs BEFORE the store subscription so a worker /
 * bookkeeper render does not fetch the gated read endpoint at all
 * (defence in depth on top of the server's 403; the early return keeps
 * the network quiet).
 *
 * Tooltip posture mirrors `BackupBadge` — the `title` attribute on the
 * badge element is the desktop hover surface. The DatenView row instead
 * exposes both buckets inline because there is no hover on touch.
 */
import { useEffect } from 'react';
import { STRINGS } from '@/config/strings';
import { usePermission } from '@/hooks/usePermission';
import { useStorageUsageStore } from '@/state/storageUsageStore';
import { formatBytes } from '@/ui/utils/formatBytes';
import styles from './Footer.module.css';

export function StorageUsageBadge() {
  const canExport = usePermission('data:export');
  const data = useStorageUsageStore((s) => s.data);

  useEffect(() => {
    if (!canExport) return;
    const unsub = useStorageUsageStore.getState().subscribe();
    return unsub;
  }, [canExport]);

  if (!canExport) return null;
  if (!data) return null;

  const readyText = formatBytes(data.ready.plaintext);
  const hiddenText = formatBytes(data.hidden.plaintext);
  const tooltip = `${STRINGS.layout.storageBucketReady}: ${readyText} · ${STRINGS.layout.storageBucketHidden}: ${hiddenText}`;

  return (
    <span className={styles.storageBadge} data-testid="storage-usage-badge" title={tooltip}>
      {STRINGS.layout.storageBadgeLabel}{' '}
      <span data-testid="storage-usage-badge-value">{readyText}</span>
    </span>
  );
}
