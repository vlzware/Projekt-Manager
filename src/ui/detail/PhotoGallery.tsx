interface PhotoGalleryProps {
  projectId: string;
}

export function PhotoGallery({ projectId }: PhotoGalleryProps) {
  void projectId;
  return <section aria-label="Fotogalerie" data-testid="project-detail-photos" />;
}
