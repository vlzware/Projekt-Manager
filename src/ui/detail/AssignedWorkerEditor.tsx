interface AssignedWorkerEditorProps {
  projectId: string;
}

export function AssignedWorkerEditor({ projectId }: AssignedWorkerEditorProps) {
  void projectId;
  return (
    <section aria-label="Zugewiesene Mitarbeiter" data-testid="project-detail-assigned-workers" />
  );
}
