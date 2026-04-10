import { useEffect, useRef } from 'react';
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
import { ProjectDetailPanel } from '@/ui/detail/ProjectDetailPanel';
import { LoginForm } from '@/ui/auth/LoginForm';
import { ConfirmDialog } from '@/ui/common/ConfirmDialog';
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
    if (insecure) {
      document.title = 'UNSICHER \u2013 ' + document.title;
    }
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
        <Route path="/" element={<Navigate to="/kanban" replace />} />
        <Route path="*" element={<Navigate to="/kanban" replace />} />
      </Routes>
    ) : // Fallback for tests that render <App /> without a router
    activeView === 'kanban' ? (
      <KanbanBoard />
    ) : (
      <CalendarView />
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
                aria-label="Fehlermeldung schließen"
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
    return <div className={styles.loading}>Laden...</div>;
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
