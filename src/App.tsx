import { useProjectStore } from '@/state/store';
import { Header } from '@/ui/layout/Header';
import { Footer } from '@/ui/layout/Footer';
import { KanbanBoard } from '@/ui/kanban/KanbanBoard';
import { CalendarView } from '@/ui/calendar/CalendarView';
import { ProjectDetailPanel } from '@/ui/detail/ProjectDetailPanel';
import styles from './App.module.css';

export function App() {
  const activeView = useProjectStore((s) => s.activeView);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const getSelectedProject = useProjectStore((s) => s.getSelectedProject);
  const selectProject = useProjectStore((s) => s.selectProject);

  const selectedProject = selectedProjectId ? getSelectedProject() : null;

  return (
    <div className={styles.app}>
      <Header />
      <main className={styles.main}>
        {activeView === 'kanban' ? <KanbanBoard /> : <CalendarView />}
      </main>
      <Footer />
      {selectedProject && (
        <ProjectDetailPanel project={selectedProject} onClose={() => selectProject(null)} />
      )}
    </div>
  );
}
