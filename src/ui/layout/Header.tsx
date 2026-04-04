import { useProjectStore } from '@/state/store';
import type { ViewMode } from '@/domain/types';
import { BRANDING } from '@/config/brandingConfig';
import { SummaryArea } from './SummaryArea';
import styles from './Header.module.css';

export function Header() {
  const activeView = useProjectStore((s) => s.activeView);
  const setView = useProjectStore((s) => s.setView);

  const views: { key: ViewMode; label: string }[] = [
    { key: 'kanban', label: 'Kanban' },
    { key: 'kalender', label: 'Kalender' },
  ];

  return (
    <header className={styles.header}>
      <div className={styles.navGroup}>
        <div className={styles.appName}>{BRANDING.appName}</div>
        <div className={styles.viewToggle}>
          {views.map((v) => (
            <button
              key={v.key}
              className={`${styles.viewButton} ${activeView === v.key ? styles.viewButtonActive : ''}`}
              onClick={() => setView(v.key)}
              data-testid={`view-toggle-${v.key}`}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.summaryWrapper}>
        <SummaryArea />
      </div>
    </header>
  );
}
