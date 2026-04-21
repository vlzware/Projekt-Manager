interface UploadCtaProps {
  projectId: string;
}

export function UploadCta({ projectId }: UploadCtaProps) {
  void projectId;
  return <section aria-label="Hochladen" data-testid="project-detail-upload-cta" />;
}
