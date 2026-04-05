import { useEffect, useRef } from 'react';
import { useProjectStore } from '@/state/store';
import { Header } from '@/ui/layout/Header';
import { Footer } from '@/ui/layout/Footer';
import { KanbanBoard } from '@/ui/kanban/KanbanBoard';
import { CalendarView } from '@/ui/calendar/CalendarView';
import { ProjectDetailPanel } from '@/ui/detail/ProjectDetailPanel';
import { LoginForm } from '@/ui/auth/LoginForm';
import styles from './App.module.css';

export function App() {
  const activeView = useProjectStore((s) => s.activeView);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const getSelectedProject = useProjectStore((s) => s.getSelectedProject);
  const selectProject = useProjectStore((s) => s.selectProject);
  const authUser = useProjectStore((s) => s.authUser);
  const sessionChecked = useProjectStore((s) => s.sessionChecked);
  const checkSession = useProjectStore((s) => s.checkSession);
  const mutationError = useProjectStore((s) => s.mutationError);
  const clearMutationError = useProjectStore((s) => s.clearMutationError);

  const selectedProject = selectedProjectId ? getSelectedProject() : null;
  const sessionCheckFired = useRef(false);

  useEffect(() => {
    if (!authUser && !sessionCheckFired.current) {
      sessionCheckFired.current = true;
      checkSession();
    }
  }, [authUser, checkSession]);

  if (authUser) {
    return (
      <div className={styles.app}>
        <Header />
        <main className={styles.main}>
          {mutationError && (
            <div className={styles.mutationError}>
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
          {activeView === 'kanban' ? <KanbanBoard /> : <CalendarView />}
        </main>
        <Footer />
        {selectedProject && (
          <ProjectDetailPanel project={selectedProject} onClose={() => selectProject(null)} />
        )}
      </div>
    );
  }

  if (!sessionChecked) {
    return <div className={styles.loading}>Laden...</div>;
  }

  return <LoginForm />;
}
