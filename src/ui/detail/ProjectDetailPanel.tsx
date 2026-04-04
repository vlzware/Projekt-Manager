import { STATE_CONFIG_MAP } from '@/config/stateConfig';
import type { Project } from '@/domain/types';
import { formatDateDE, formatCurrencyDE } from '@/domain/dateFormat';
import { canTransitionForward, canTransitionBackward, getNextState, getPreviousState } from '@/domain/transitions';
import { useProjectStore } from '@/state/store';
import styles from './ProjectDetailPanel.module.css';

interface ProjectDetailPanelProps {
  project: Project;
  onClose: () => void;
}

export function ProjectDetailPanel({ project, onClose }: ProjectDetailPanelProps) {
  const transitionForward = useProjectStore((s) => s.transitionForward);
  const transitionBackward = useProjectStore((s) => s.transitionBackward);
  const updateDates = useProjectStore((s) => s.updateDates);
  const projects = useProjectStore((s) => s.projects);

  // Always get fresh project data from store
  const currentProject = projects.find((p) => p.id === project.id) ?? project;
  const config = STATE_CONFIG_MAP[currentProject.status];
  const showForward = canTransitionForward(currentProject.status);
  const showBackward = canTransitionBackward(currentProject.status);

  const handleForward = () => {
    const next = getNextState(currentProject.status);
    if (!next) return;
    const nextLabel = STATE_CONFIG_MAP[next].label;
    const confirmed = window.confirm(
      `Status ändern: ${config.label} → ${nextLabel}?`
    );
    if (confirmed) {
      transitionForward(currentProject.id);
    }
  };

  const handleBackward = () => {
    const prev = getPreviousState(currentProject.status);
    if (!prev) return;
    const prevLabel = STATE_CONFIG_MAP[prev].label;
    const confirmed = window.confirm(
      `Status ändern: ${config.label} → ${prevLabel}?`
    );
    if (confirmed) {
      transitionBackward(currentProject.id);
    }
  };

  const handleStartDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    updateDates(currentProject.id, val || null, undefined);
  };

  const handleEndDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    updateDates(currentProject.id, undefined, val || null);
  };

  const mapsUrl = currentProject.address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        `${currentProject.address.street} ${currentProject.address.zip} ${currentProject.address.city}`
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
            aria-label="Schließen"
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
          {(showForward || showBackward) && (
            <div className={styles.transitionButtons}>
              {showForward && (
                <button
                  className={styles.forwardBtn}
                  onClick={handleForward}
                  data-testid="detail-forward-button"
                >
                  Nächster Schritt
                </button>
              )}
              {showBackward && (
                <button
                  className={styles.backwardBtn}
                  onClick={handleBackward}
                  data-testid="detail-backward-button"
                >
                  Vorheriger Schritt
                </button>
              )}
            </div>
          )}

          {/* Customer */}
          <div className={styles.section}>
            <div className={styles.sectionLabel}>Kunde</div>
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
              <div className={styles.sectionLabel}>Adresse</div>
              <div className={styles.fieldValue}>
                {currentProject.address.street}
                <br />
                {currentProject.address.zip} {currentProject.address.city}
              </div>
              {mapsUrl && (
                <a
                  className={styles.link}
                  href={mapsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  In Google Maps öffnen
                </a>
              )}
            </div>
          )}

          {/* Dates */}
          <div className={styles.section}>
            <div className={styles.sectionLabel}>Termine</div>
            <div className={styles.dateInputs}>
              <div className={styles.dateField}>
                <label className={styles.dateLabel}>Beginn</label>
                <input
                  type="date"
                  className={styles.dateInput}
                  value={currentProject.plannedStart ?? ''}
                  onChange={handleStartDateChange}
                  data-testid="detail-date-start"
                />
              </div>
              <div className={styles.dateField}>
                <label className={styles.dateLabel}>Ende</label>
                <input
                  type="date"
                  className={styles.dateInput}
                  value={currentProject.plannedEnd ?? ''}
                  onChange={handleEndDateChange}
                  data-testid="detail-date-end"
                />
              </div>
            </div>
          </div>

          {/* Workers */}
          {currentProject.assignedWorkers && currentProject.assignedWorkers.length > 0 && (
            <div className={styles.section}>
              <div className={styles.sectionLabel}>Mitarbeiter</div>
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
              <div className={styles.sectionLabel}>Geschätzter Wert</div>
              <div className={styles.fieldValue}>
                {formatCurrencyDE(currentProject.estimatedValue)}
              </div>
            </div>
          )}

          {/* Notes */}
          {currentProject.notes && (
            <div className={styles.section}>
              <div className={styles.sectionLabel}>Notizen</div>
              <div className={styles.notes}>{currentProject.notes}</div>
            </div>
          )}

          {/* Timestamps */}
          <div className={styles.timestamps}>
            <span>Erstellt: {formatDateDE(currentProject.createdAt)}</span>
            <span>Aktualisiert: {formatDateDE(currentProject.updatedAt)}</span>
            <span>Status seit: {formatDateDE(currentProject.statusChangedAt)}</span>
          </div>
        </div>
      </div>
    </>
  );
}
