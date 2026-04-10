import { useState, useEffect, useRef } from 'react';
import { useAuthStore } from '@/state/authStore';
import { useUIStore } from '@/state/uiStore';
import { clearStoresOnLogout } from '@/state/store';
import { useRouterNav, pathFromView } from '@/hooks/useRouterNav';
import type { ViewMode } from '@/domain/types';
import { BRANDING } from '@/config/brandingConfig';
import { STRINGS } from '@/config/strings';
import { SummaryArea } from './SummaryArea';
import styles from './Header.module.css';

export function Header() {
  const activeView = useUIStore((s) => s.activeView);
  const authUser = useAuthStore((s) => s.authUser);
  const logout = useAuthStore((s) => s.logout);
  const { navigateTo } = useRouterNav();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dropdownOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [dropdownOpen]);

  const views: { key: ViewMode; label: string }[] = [
    { key: 'kanban', label: STRINGS.ui.viewKanban },
    { key: 'kalender', label: STRINGS.ui.viewCalendar },
  ];

  const handleLogout = async () => {
    setDropdownOpen(false);
    await logout();
    clearStoresOnLogout();
  };

  return (
    <header className={styles.header}>
      <div className={styles.navGroup}>
        <div className={styles.appName}>{BRANDING.appName}</div>
        <div className={styles.viewToggle}>
          {views.map((v) => (
            <button
              key={v.key}
              className={`${styles.viewButton} ${activeView === v.key ? styles.viewButtonActive : ''}`}
              onClick={() => navigateTo(pathFromView(v.key))}
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
      {authUser && (
        <div className={styles.userMenu} ref={menuRef}>
          <button
            className={styles.userButton}
            data-testid="user-indicator"
            onClick={() => setDropdownOpen(!dropdownOpen)}
          >
            {authUser.displayName}
          </button>
          {dropdownOpen && (
            <div className={styles.dropdown}>
              <button
                className={styles.dropdownItem}
                data-testid="logout-button"
                onClick={handleLogout}
              >
                {STRINGS.auth.logout}
              </button>
            </div>
          )}
        </div>
      )}
    </header>
  );
}
