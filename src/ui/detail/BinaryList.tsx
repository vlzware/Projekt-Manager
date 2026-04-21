interface BinaryListProps {
  projectId: string;
}

export function BinaryList({ projectId }: BinaryListProps) {
  void projectId;
  return <section aria-label="Dateien" data-testid="project-detail-binaries" />;
}
