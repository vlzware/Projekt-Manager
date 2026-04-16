import { useState, useEffect, useRef } from 'react';
import { useAuthStore } from '@/state/authStore';
import { useUIStore } from '@/state/uiStore';
import { usePermission } from '@/hooks/usePermission';
import { useRouterNav } from '@/hooks/useRouterNav';
import { visibleRoutesForUser } from '@/config/routes';
import { BRANDING } from '@/config/brandingConfig';
import { STRINGS } from '@/config/strings';
import type { ThemePreference } from '@/config/themeStorage';
import { SummaryArea } from './SummaryArea';
import { EmailExtractModal } from '../extraction/EmailExtractModal';
import { PasswordChangeModal } from './PasswordChangeModal';
import styles from './Header.module.css';

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: STRINGS.theme.light },
  { value: 'dark', label: STRINGS.theme.dark },
  { value: 'system', label: STRINGS.theme.system },
];

export function Header() {
  const activeView = useUIStore((s) => s.activeView);
  const authUser = useAuthStore((s) => s.authUser);
  const logout = useAuthStore((s) => s.logout);
  const updateThemePreference = useAuthStore((s) => s.updateThemePreference);
  const { navigateTo } = useRouterNav();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [extractOpen, setExtractOpen] = useState(false);
  const [pwChangeOpen, setPwChangeOpen] = useState(false);
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

  // Navigation is driven from the central route table so the per-role
  // matrix (`docs/spec/ui.md §8.7.1`, AC-75) has one source of truth —
  // the guard in `App.tsx` consults the same table. Extractor visibility
  // is an action affordance (not a nav concern), so it stays permission-
  // driven via `usePermission`.
  const visibleRoutes = authUser ? visibleRoutesForUser(authUser) : [];
  const canExtract = usePermission('customer:write');

  const handleLogout = async () => {
    setDropdownOpen(false);
    // authStore.logout() now clears downstream project/UI state itself
    // so the session-expired path and the interactive logout path
    // cannot diverge (consolidation review C F-6).
    await logout();
  };

  const handleThemeSelect = (value: ThemePreference) => {
    // Fire-and-forget: the store handles optimistic update, server
    // round-trip, and revert-on-failure. Swallow the returned promise so
    // the click handler stays synchronous from React's perspective.
    void updateThemePreference(value);
  };

  return (
    <header className={styles.header} data-testid="header">
      <div className={styles.navGroup}>
        <div className={styles.appName}>{BRANDING.appName}</div>
        <div className={styles.viewToggle}>
          {visibleRoutes.map((r) => (
            <button
              key={r.view}
              className={`${styles.viewButton} ${activeView === r.view ? styles.viewButtonActive : ''}`}
              onClick={() => navigateTo(r.path)}
              data-testid={`view-toggle-${r.view}`}
            >
              {r.label}
            </button>
          ))}
        </div>
        {canExtract && (
          <button
            className={styles.extractButton}
            onClick={() => setExtractOpen(true)}
            data-testid="extract-button"
            title={STRINGS.ui.extractEmail}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M22 4L12 13L2 4" />
            </svg>
          </button>
        )}
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
              <div className={styles.dropdownSection}>
                <div className={styles.dropdownSectionLabel}>{STRINGS.theme.section}</div>
                {THEME_OPTIONS.map((opt) => {
                  const selected = authUser.themePreference === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      className={`${styles.dropdownItem} ${selected ? styles.dropdownItemSelected : ''}`}
                      aria-pressed={selected}
                      data-testid={`theme-option-${opt.value}`}
                      onClick={() => handleThemeSelect(opt.value)}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              <button
                className={styles.dropdownItem}
                data-testid="pw-change-button"
                onClick={() => {
                  setDropdownOpen(false);
                  setPwChangeOpen(true);
                }}
              >
                {STRINGS.password.change}
              </button>
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
      {pwChangeOpen && <PasswordChangeModal onClose={() => setPwChangeOpen(false)} />}
    </header>
  );
}
