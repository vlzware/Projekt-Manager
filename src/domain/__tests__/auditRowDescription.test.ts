/**
 * Tests for `describeAuditRow` — the one-line German description of an
 * audit row shown in the project detail feed and the global Aktivität
 * view (ui/workflow-views.md §8.4.1, ui/management.md §8.13.1).
 *
 * Pins the three exemplars listed in the spec:
 *   - "Status geändert: Geplant → In Arbeit"
 *   - "Termine aktualisiert"
 *   - "Mitarbeiter zugewiesen: Jan Nowak"
 * plus the mirror-case "Zuweisung aufgehoben: ..." and the generic
 * fallback (unknown action, non-payload-carrying rows).
 */

import { describe, it, expect } from 'vitest';
import { describeAuditRow } from '../auditRowDescription';

describe('describeAuditRow', () => {
  it('renders a forward transition as "Status geändert: From → To"', () => {
    const out = describeAuditRow({
      action: 'transition:forward',
      entityType: 'project',
      payload: {
        before: { status: 'geplant', statusChangedAt: '2026-04-01T10:00:00.000Z' },
        after: { status: 'in_arbeit', statusChangedAt: '2026-04-20T10:00:00.000Z' },
      },
    });
    expect(out).toBe('Status geändert: Geplant → In Arbeit');
  });

  it('renders a backward transition with arrow in forward-order reading direction', () => {
    const out = describeAuditRow({
      action: 'transition:backward',
      entityType: 'project',
      payload: {
        before: { status: 'in_arbeit' },
        after: { status: 'geplant' },
      },
    });
    // Direction is "before → after" regardless of forward/backward — the
    // arrow represents the state change, not the workflow direction.
    expect(out).toBe('Status geändert: In Arbeit → Geplant');
  });

  it('falls back to the generic label when a transition payload is malformed', () => {
    const out = describeAuditRow({
      action: 'transition:forward',
      entityType: 'project',
      payload: { before: {}, after: {} },
    });
    expect(out).toBe('Status weiter');
  });

  it('renders a project update touching plannedStart/plannedEnd as "Termine aktualisiert"', () => {
    const out = describeAuditRow({
      action: 'update',
      entityType: 'project',
      payload: {
        before: { plannedStart: '2026-04-01' },
        after: { plannedStart: '2026-04-10' },
      },
    });
    expect(out).toBe('Termine aktualisiert');
  });

  it('renders a project update touching only plannedEnd as "Termine aktualisiert"', () => {
    const out = describeAuditRow({
      action: 'update',
      entityType: 'project',
      payload: {
        before: { plannedEnd: null },
        after: { plannedEnd: '2026-05-01' },
      },
    });
    expect(out).toBe('Termine aktualisiert');
  });

  it('does NOT render "Termine aktualisiert" when the update touches non-date fields only', () => {
    // Rationale: a notes-only change must not pretend to be a date
    // change. The generic label is the correct fallback.
    const out = describeAuditRow({
      action: 'update',
      entityType: 'project',
      payload: {
        before: { notes: 'old' },
        after: { notes: 'new' },
      },
    });
    expect(out).toBe('Aktualisiert');
  });

  it('renders project_worker create with displayName as "Mitarbeiter zugewiesen: <name>"', () => {
    const out = describeAuditRow({
      action: 'create',
      entityType: 'project_worker',
      payload: {
        before: {},
        after: { projectId: 'p-1', userId: 'u-1', displayName: 'Jan Nowak' },
      },
    });
    expect(out).toBe('Mitarbeiter zugewiesen: Jan Nowak');
  });

  it('renders project_worker delete with displayName as "Zuweisung aufgehoben: <name>"', () => {
    const out = describeAuditRow({
      action: 'delete',
      entityType: 'project_worker',
      payload: {
        before: { projectId: 'p-1', userId: 'u-1', displayName: 'Jan Nowak' },
        after: {},
      },
    });
    expect(out).toBe('Zuweisung aufgehoben: Jan Nowak');
  });

  it('renders project_worker create without displayName as the bare label', () => {
    // Null payload is the defensive branch — an import or legacy row
    // may omit the displayName. The description must still render
    // something meaningful; the bare German label is that fallback.
    const out = describeAuditRow({
      action: 'create',
      entityType: 'project_worker',
      payload: null,
    });
    expect(out).toBe('Mitarbeiter zugewiesen');
  });

  it('renders a project archive (soft-delete) via the generic label', () => {
    // The `archive` action is distinct from `delete` and `purge` — the
    // generic label from auditActionLabels carries the correct copy.
    const out = describeAuditRow({
      action: 'archive',
      entityType: 'project',
      payload: { before: { number: 'P-1', title: 'X' }, after: {} },
    });
    expect(out).toBe('Archiviert');
  });

  it('falls back to labelForAuditAction for known non-enriched actions', () => {
    const out = describeAuditRow({
      action: 'purge',
      entityType: 'project',
      payload: null,
    });
    expect(out).toBe('Endgültig gelöscht');
  });

  it('returns the raw action string for unknown actions (forward-compat)', () => {
    // data-model.md §5.10 pins action as free-text; the UI must render
    // something for an action it has not learned yet.
    const out = describeAuditRow({
      action: 'attachment:add',
      entityType: 'project',
      payload: null,
    });
    expect(out).toBe('attachment:add');
  });
});
