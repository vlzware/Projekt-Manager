import { useParams } from 'react-router-dom';
import { STRINGS } from '@/config/strings';
import { PhotoGallery } from './PhotoGallery';
import { BinaryList } from './BinaryList';
import { AssignedWorkerEditor } from './AssignedWorkerEditor';
import { UploadCta } from './UploadCta';

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const projectId = id ?? '';

  return (
    <article aria-label={STRINGS.ui.viewDetails} data-testid="project-detail-page">
      <header aria-label="Projekt-Kopf" data-testid="project-detail-header">
        {projectId}
      </header>
      <section aria-label="Kernfelder" data-testid="project-detail-core" />
      <AssignedWorkerEditor projectId={projectId} />
      <UploadCta projectId={projectId} />
      <PhotoGallery projectId={projectId} />
      <BinaryList projectId={projectId} />
      <section aria-label="Aktivität" data-testid="project-detail-activity" />
    </article>
  );
}
