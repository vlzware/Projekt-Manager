import { STATE_CONFIG_MAP } from '@/config/stateConfig';
import { STRINGS } from '@/config/strings';
import type { Project } from '@/domain/types';
import { formatDateDE, formatCurrencyDE } from '@/domain/dateFormat';
import { useProjectTransition } from '@/hooks/useProjectTransition';
import { useProjectStore } from '@/state/projectStore';
import { dateInputValue } from './dateInputValue';
import styles from './ProjectDetailPanel.module.css';

interface ProjectDetailPanelProps {
  project: Project;
  onClose: () => void;
}

export function ProjectDetailPanel({ project, onClose }: ProjectDetailPanelProps) {
  const updateDates = useProjectStore((s) => s.updateDates);
  const projects = useProjectStore((s) => s.projects);

  // Always get fresh project data from store
  const currentProject = projects.find((p) => p.id === project.id) ?? project;
  const config = STATE_CONFIG_MAP[currentProject.status];
  const { canForward, canBackward, forward, backward } = useProjectTransition(currentProject);

  const handleStartDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (!val && currentProject.plannedEnd) {
      // Clearing start also clears end (spec §8.4, data-model §6.8)
      updateDates(currentProject.id, null, null);
    } else {
      updateDates(currentProject.id, val || null, undefined);
    }
  };

  const handleEndDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    updateDates(currentProject.id, undefined, val || null);
  };

  const mapsUrl = currentProject.address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        `${currentProject.address.street} ${currentProject.address.zip} ${currentProject.address.city}`,
      )}`
    : null;

  return (
    <>
      <div className={styles.overlay} onClick={onClose} data-testid="detail-overlay" />
      <div className={styles.panel} data-testid="detail-panel">
        <div className={styles.header}>
          <div className={styles.headerInfo}>
            <div className={styles.projectNumber}>{currentProject.number}</div>
            <div className={styles.projectTitle}>{currentProject.title}</div>
          </div>
          <button
            className={styles.closeButton}
            onClick={onClose}
            data-testid="detail-close"
            aria-label={STRINGS.ui.close}
          >
            &times;
          </button>
        </div>

        <div className={styles.body}>
          {/* Status */}
          <div className={styles.section}>
            <div className={styles.sectionLabel}>Status</div>
            <span
              className={styles.badge}
              style={{ backgroundColor: config.color }}
              data-testid="detail-status-badge"
            >
              {config.label}
            </span>
          </div>

          {/* Transitions */}
          {(canForward || canBackward) && (
            <div className={styles.transitionButtons}>
              {canForward && (
                <button
                  className={styles.forwardBtn}
                  onClick={forward}
                  data-testid="detail-forward-button"
                >
                  {STRINGS.ui.nextStep}
                </button>
              )}
              {canBackward && (
                <button
                  className={styles.backwardBtn}
                  onClick={backward}
                  data-testid="detail-backward-button"
                >
                  {STRINGS.ui.prevStep}
                </button>
              )}
            </div>
          )}

          {/* Customer */}
          <div className={styles.section}>
            <div className={styles.sectionLabel}>{STRINGS.ui.customer}</div>
            <div className={styles.fieldValue}>{currentProject.customer.name}</div>
            {currentProject.customer.phone && (
              <a className={styles.link} href={`tel:${currentProject.customer.phone}`}>
                {currentProject.customer.phone}
              </a>
            )}
            {currentProject.customer.email && (
              <a className={styles.link} href={`mailto:${currentProject.customer.email}`}>
                {currentProject.customer.email}
              </a>
            )}
          </div>

          {/* Address */}
          {currentProject.address && (
            <div className={styles.section}>
              <div className={styles.sectionLabel}>{STRINGS.ui.address}</div>
              <div className={styles.fieldValue}>
                {currentProject.address.street}
                <br />
                {currentProject.address.zip} {currentProject.address.city}
              </div>
              {mapsUrl && (
                <a className={styles.link} href={mapsUrl} target="_blank" rel="noopener noreferrer">
                  {STRINGS.ui.openMaps}
                </a>
              )}
            </div>
          )}

          {/* Dates */}
          <div className={styles.section}>
            <div className={styles.sectionLabel}>{STRINGS.ui.dates}</div>
            <div className={styles.dateInputs}>
              <div className={styles.dateField}>
                <label className={styles.dateLabel}>{STRINGS.ui.dateStart}</label>
                <input
                  type="date"
                  className={styles.dateInput}
                  value={dateInputValue(currentProject.plannedStart)}
                  onChange={handleStartDateChange}
                  data-testid="detail-date-start"
                />
              </div>
              <div className={styles.dateField}>
                <label className={styles.dateLabel}>{STRINGS.ui.dateEnd}</label>
                <input
                  type="date"
                  className={styles.dateInput}
                  value={dateInputValue(currentProject.plannedEnd)}
                  onChange={handleEndDateChange}
                  data-testid="detail-date-end"
                />
              </div>
            </div>
          </div>

          {/* Workers */}
          {currentProject.assignedWorkers && currentProject.assignedWorkers.length > 0 && (
            <div className={styles.section}>
              <div className={styles.sectionLabel}>{STRINGS.ui.workers}</div>
              <div className={styles.workerList}>
                {currentProject.assignedWorkers.map((w) => (
                  <span key={w} className={styles.workerTag}>
                    {w}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Estimated value */}
          {currentProject.estimatedValue !== undefined && (
            <div className={styles.section}>
              <div className={styles.sectionLabel}>{STRINGS.ui.estimatedValue}</div>
              <div className={styles.fieldValue}>
                {formatCurrencyDE(currentProject.estimatedValue)}
              </div>
            </div>
          )}

          {/* Notes */}
          {currentProject.notes && (
            <div className={styles.section}>
              <div className={styles.sectionLabel}>{STRINGS.ui.notes}</div>
              <div className={styles.notes}>{currentProject.notes}</div>
            </div>
          )}

          {/* Timestamps */}
          <div className={styles.timestamps}>
            <span>{STRINGS.ui.created} {formatDateDE(currentProject.createdAt)}</span>
            <span>{STRINGS.ui.updated} {formatDateDE(currentProject.updatedAt)}</span>
            <span>{STRINGS.ui.statusSince} {formatDateDE(currentProject.statusChangedAt)}</span>
          </div>
        </div>
      </div>
    </>
  );
}
