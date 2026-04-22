/**
 * Project detail page — full-context view of a single project at
 * `/projects/:id` (spec §8.15). Six regions in spec order: header,
 * core fields, assigned workers, photos, binaries, activity feed.
 *
 * Out-of-scope workers land here via the server returning
 * NOT_PERMITTED — render the AC-149 mirror surface (spec §8.15).
 */

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { STRINGS } from '@/config/strings';
import { STATE_CONFIG_MAP } from '@/config/stateConfig';
import { useProjectStore, type FetchProjectOutcome } from '@/state/projectStore';
import { useAttachmentStore } from '@/state/attachmentStore';
import { usePermission } from '@/hooks/usePermission';
import { formatDateDE, formatCurrencyDE } from '@/domain/dateFormat';
import { ActivityFeed } from '@/ui/audit/ActivityFeed';
import { NotPermittedView } from '@/ui/common/NotPermittedView';
import { PhotoGallery } from './PhotoGallery';
import { BinaryList } from './BinaryList';
import { AssignedWorkerEditor } from './AssignedWorkerEditor';
import { UploadCta } from './UploadCta';
import styles from './ProjectDetail.module.css';

type LoadState = { kind: 'loading' } | FetchProjectOutcome;

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const projectId = id ?? '';
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const canReadAudit = usePermission('audit:read');
  const canWrite = usePermission('attachment:write');
  const fetchProject = useProjectStore((s) => s.fetchProject);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const outcome = await fetchProject(projectId);
      if (cancelled) return;
      setState(outcome);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, fetchProject]);

  // Abort in-flight uploads when the user navigates away or the project
  // id changes. `useAttachmentStore.getState()` is the stable way to
  // read the latest action without subscribing (a subscription would
  // re-run the cleanup effect on every store update). Matches the
  // store's lifecycle contract in `cancelUploadsForProject`.
  useEffect(() => {
    return () => {
      useAttachmentStore.getState().cancelUploadsForProject(projectId);
    };
  }, [projectId]);

  if (state.kind === 'loading') {
    return <div className={styles.loading}>{STRINGS.ui.loading}</div>;
  }

  if (state.kind === 'not_permitted') {
    return <NotPermittedView />;
  }

  if (state.kind === 'not_found') {
    return (
      <article className={styles.notFound} data-testid="project-detail-not-found">
        <h1>{STRINGS.attachments.notFoundHeading}</h1>
        <p>{STRINGS.attachments.notFoundBody}</p>
      </article>
    );
  }

  if (state.kind === 'error') {
    return <div className={styles.errorBanner}>{state.message}</div>;
  }

  const { project } = state;
  const config = STATE_CONFIG_MAP[project.status];
  const customer = project.customer;
  const address = customer?.address ?? null;
  const mapsUrl = address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        `${address.street} ${address.zip} ${address.city}`,
      )}`
    : null;

  return (
    <article
      aria-label={STRINGS.ui.viewDetails}
      data-testid="project-detail-page"
      className={styles.page}
    >
      <header data-testid="project-detail-header" className={styles.header}>
        <div className={styles.projectNumber}>{project.number}</div>
        <h1 className={styles.projectTitle}>{project.title}</h1>
        <span className={styles.statusBadge} style={{ backgroundColor: config?.color }}>
          {config?.label ?? project.status}
        </span>
      </header>

      <section
        aria-label={STRINGS.attachments.coreFields}
        data-testid="project-detail-core"
        className={styles.coreSection}
      >
        <h3 className={styles.regionHeading}>{STRINGS.attachments.coreFields}</h3>
        <dl className={styles.coreGrid}>
          <div>
            <dt>{STRINGS.ui.customer}</dt>
            <dd>{customer?.name ?? '—'}</dd>
          </div>
          {address && (
            <div>
              <dt>{STRINGS.ui.address}</dt>
              <dd>
                {address.street}, {address.zip} {address.city}
                {mapsUrl && (
                  <>
                    {' '}
                    <a href={mapsUrl} target="_blank" rel="noopener noreferrer">
                      {STRINGS.ui.openMaps}
                    </a>
                  </>
                )}
              </dd>
            </div>
          )}
          <div>
            <dt>{STRINGS.ui.dateStart}</dt>
            <dd>{project.plannedStart ? formatDateDE(project.plannedStart) : '—'}</dd>
          </div>
          <div>
            <dt>{STRINGS.ui.dateEnd}</dt>
            <dd>{project.plannedEnd ? formatDateDE(project.plannedEnd) : '—'}</dd>
          </div>
          <div>
            <dt>{STRINGS.ui.estimatedValue}</dt>
            <dd>
              {project.estimatedValue != null ? formatCurrencyDE(project.estimatedValue) : '—'}
            </dd>
          </div>
          {project.notes && (
            <div className={styles.notesRow}>
              <dt>{STRINGS.ui.notes}</dt>
              <dd className={styles.notes}>{project.notes}</dd>
            </div>
          )}
        </dl>
      </section>

      <AssignedWorkerEditor projectId={project.id} />

      {canWrite && <UploadCta projectId={project.id} />}

      <PhotoGallery projectId={project.id} />

      <BinaryList projectId={project.id} />

      <section
        aria-label={STRINGS.attachments.activity}
        data-testid="project-detail-activity"
        className={styles.activitySection}
      >
        <h3 className={styles.regionHeading}>{STRINGS.attachments.activity}</h3>
        {canReadAudit && (
          <ActivityFeed
            // Ancestor-scoped filter (architecture.md §11.12) — returns
            // project rows + nested-entity rows (project_worker,
            // attachment) in one indexed query.
            filters={{ ancestorType: 'project', ancestorId: project.id }}
            filterKey={`project-detail:${project.id}`}
            testId="project-detail-activity-feed"
            inline
          />
        )}
      </section>
    </article>
  );
}
