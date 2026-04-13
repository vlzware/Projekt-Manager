import { useState, useEffect, useRef } from 'react';
import { useAuthStore } from '@/state/authStore';
import { useUIStore } from '@/state/uiStore';
import { useRouterNav, pathFromView } from '@/hooks/useRouterNav';
import type { ViewMode } from '@/domain/types';
import { BRANDING } from '@/config/brandingConfig';
import { STRINGS } from '@/config/strings';
import { SummaryArea } from './SummaryArea';
import { EmailExtractModal } from '../extraction/EmailExtractModal';
import styles from './Header.module.css';

export function Header() {
  const activeView = useUIStore((s) => s.activeView);
  const authUser = useAuthStore((s) => s.authUser);
  const logout = useAuthStore((s) => s.logout);
  const { navigateTo } = useRouterNav();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [extractOpen, setExtractOpen] = useState(false);
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

  const canReadUsers = authUser?.roles.some((r) => r === 'owner' || r === 'office') ?? false;
  const canExtract = canReadUsers; // owner and office can use extraction

  const views: { key: ViewMode; label: string }[] = [
    { key: 'kanban', label: STRINGS.ui.viewKanban },
    { key: 'kalender', label: STRINGS.ui.viewCalendar },
    { key: 'projekte', label: STRINGS.ui.viewProjects },
    { key: 'kunden', label: STRINGS.ui.viewCustomers },
    ...(canReadUsers ? [{ key: 'benutzer' as ViewMode, label: STRINGS.ui.viewUsers }] : []),
    { key: 'daten', label: STRINGS.ui.viewData },
  ];

  const handleLogout = async () => {
    setDropdownOpen(false);
    // authStore.logout() now clears downstream project/UI state itself
    // so the session-expired path and the interactive logout path
    // cannot diverge (consolidation review C F-6).
    await logout();
  };

  return (
    <header className={styles.header} data-testid="header">
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
      {canExtract && (
        <button
          className={styles.extractButton}
          onClick={() => setExtractOpen(true)}
          data-testid="extract-button"
        >
          {STRINGS.ui.extractEmail}
        </button>
      )}
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
      {extractOpen && <EmailExtractModal onClose={() => setExtractOpen(false)} />}
    </header>
  );
}
