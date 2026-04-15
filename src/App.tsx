import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Routes, Route, Navigate, useInRouterContext, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/state/authStore';
import { useProjectStore } from '@/state/projectStore';
import { useUIStore } from '@/state/uiStore';
import { viewFromPath } from '@/hooks/useRouterNav';
import { isInsecureConnection } from '@/config/insecureConnection';
import { Header } from '@/ui/layout/Header';
import { Footer } from '@/ui/layout/Footer';
import { KanbanBoard } from '@/ui/kanban/KanbanBoard';
import { CalendarView } from '@/ui/calendar/CalendarView';
import { CustomerManagement } from '@/ui/management/CustomerManagement';
import { ProjectManagement } from '@/ui/management/ProjectManagement';
import { UserManagement } from '@/ui/management/UserManagement';
import { DatenView } from '@/ui/management/DatenView';
import { ProjectDetailPanel } from '@/ui/detail/ProjectDetailPanel';
import { LoginForm } from '@/ui/auth/LoginForm';
import { ConfirmDialog } from '@/ui/common/ConfirmDialog';
import { STRINGS } from '@/config/strings';
import styles from './App.module.css';

/**
 * Sync URL → Zustand store. Components that read `activeView` from the store
 * (e.g. Header highlight) stay in sync with the URL.
 * Only runs when a router context is present (skipped in tests).
 */
function useUrlToStoreSync() {
  const location = useLocation();
  const setView = useUIStore((s) => s.setView);

  useEffect(() => {
    const view = viewFromPath(location.pathname);
    if (useUIStore.getState().activeView !== view) {
      setView(view);
    }
  }, [location.pathname, setView]);
}

/** Wrapper that calls useUrlToStoreSync only when inside a router context. */
function UrlStoreSync() {
  useUrlToStoreSync();
  return null;
}

/**
 * Route guard — renders children only if the authenticated user
 * has at least one of the required roles. Redirects to /kanban otherwise.
 */
function RequireRoles({ roles, children }: { roles: string[]; children: ReactNode }) {
  const authUser = useAuthStore((s) => s.authUser);
  const hasAccess = authUser?.roles.some((r) => roles.includes(r)) ?? false;
  if (!hasAccess) return <Navigate to="/kanban" replace />;
  return <>{children}</>;
}

export function App() {
  const hasRouter = useInRouterContext();
  const activeView = useUIStore((s) => s.activeView);
  const selectedProjectId = useUIStore((s) => s.selectedProjectId);
  const selectProject = useUIStore((s) => s.selectProject);
  const authUser = useAuthStore((s) => s.authUser);
  const sessionChecked = useAuthStore((s) => s.sessionChecked);
  const mutationError = useProjectStore((s) => s.mutationError);
  const clearMutationError = useProjectStore((s) => s.clearMutationError);
  const projects = useProjectStore((s) => s.projects);

  const insecure = isInsecureConnection();

  const selectedProject = selectedProjectId
    ? (projects.find((p) => p.id === selectedProjectId) ?? null)
    : null;
  const sessionCheckFired = useRef(false);

  useEffect(() => {
    if (!insecure) return;
    // Snapshot the current title and restore it on cleanup. Without the
    // restore, React 19 StrictMode's double-mount in dev produces
    // "UNSICHER – UNSICHER – Projekt-Manager" because the effect runs
    // twice without reverting between runs (consolidation review
    // round-2 C M-2). The cleanup also handles the case where `insecure`
    // flips false at runtime (would never happen in practice, but
    // writing it correctly costs nothing).
    const previous = document.title;
    document.title = 'UNSICHER \u2013 ' + previous;
    return () => {
      document.title = previous;
    };
  }, [insecure]);

  useEffect(() => {
    if (!authUser && !sessionCheckFired.current) {
      sessionCheckFired.current = true;
      useAuthStore
        .getState()
        .checkSession()
        .then(() => {
          if (useAuthStore.getState().authUser) {
            useProjectStore.getState().fetchProjects();
          }
        });
    }
  }, [authUser]);

  if (authUser) {
    // View content — either router-managed or store-managed
    const viewContent = hasRouter ? (
      <Routes>
        <Route path="/kanban" element={<KanbanBoard />} />
        <Route path="/calendar" element={<CalendarView />} />
        <Route path="/customers" element={<CustomerManagement />} />
        <Route path="/projects" element={<ProjectManagement />} />
        <Route
          path="/users"
          element={
            <RequireRoles roles={['owner', 'office']}>
              <UserManagement />
            </RequireRoles>
          }
        />
        <Route path="/data" element={<DatenView />} />
        <Route path="/" element={<Navigate to="/kanban" replace />} />
        <Route path="*" element={<Navigate to="/kanban" replace />} />
      </Routes>
    ) : // Fallback for tests that render <App /> without a router
    activeView === 'kanban' ? (
      <KanbanBoard />
    ) : activeView === 'kalender' ? (
      <CalendarView />
    ) : activeView === 'kunden' ? (
      <CustomerManagement />
    ) : activeView === 'projekte' ? (
      <ProjectManagement />
    ) : activeView === 'benutzer' ? (
      authUser?.roles.some((r) => r === 'owner' || r === 'office') ? (
        <UserManagement />
      ) : (
        <KanbanBoard />
      )
    ) : activeView === 'daten' ? (
      <DatenView />
    ) : (
      <KanbanBoard />
    );

    return (
      <div className={styles.app}>
        {hasRouter && <UrlStoreSync />}
        {insecure && (
          <div className={styles.insecureBanner} role="alert" data-testid="insecure-banner">
            UNSICHERER MODUS &mdash; Keine Verschl&uuml;sselung, Zugangsdaten werden im Klartext
            &uuml;bertragen
          </div>
        )}
        <Header />
        <main className={styles.main}>
          {mutationError && (
            <div className={styles.mutationError} role="alert" data-testid="mutation-error-banner">
              <span>{mutationError}</span>
              <button
                className={styles.mutationErrorDismiss}
                onClick={clearMutationError}
                aria-label={STRINGS.ui.closeError}
              >
                &#x2715;
              </button>
            </div>
          )}
          {viewContent}
        </main>
        <Footer />
        {selectedProject && (
          <ProjectDetailPanel project={selectedProject} onClose={() => selectProject(null)} />
        )}
        <ConfirmDialog />
      </div>
    );
  }

  if (!sessionChecked) {
    return <div className={styles.loading}>{STRINGS.ui.loading}</div>;
  }

  return (
    <>
      {insecure && (
        <div className={styles.insecureBanner} role="alert" data-testid="insecure-banner">
          UNSICHERER MODUS &mdash; Keine Verschl&uuml;sselung, Zugangsdaten werden im Klartext
          &uuml;bertragen
        </div>
      )}
      <LoginForm />
    </>
  );
}
