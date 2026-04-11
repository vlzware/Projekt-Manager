import { describe, it, expect } from 'vitest';
import { computeSummary } from '../summary';
import type { Project } from '../types';

function makeProject(
  overrides: Partial<Project> & { id: string; status: Project['status'] },
): Project {
  return {
    number: '2026-001',
    title: 'Test',
    statusChangedAt: '2026-04-01T00:00:00Z',
    customer: { name: 'Test Customer' },
    address: null,
    plannedStart: null,
    plannedEnd: null,
    assignedWorkers: null,
    estimatedValue: null,
    notes: null,
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    createdBy: null,
    updatedBy: null,
    ...overrides,
  };
}

describe('summary computation', () => {
  // UT-8: Correctly counts projects per action state
  it('UT-8: correctly counts projects per action state', () => {
    const now = new Date('2026-04-03T12:00:00Z');
    const projects: Project[] = [
      makeProject({ id: '1', status: 'anfrage' }),
      makeProject({ id: '2', status: 'anfrage' }),
      makeProject({ id: '3', status: 'rechnung_faellig' }),
      makeProject({ id: '4', status: 'rechnung_faellig' }),
      makeProject({ id: '5', status: 'rechnung_faellig' }),
      makeProject({ id: '6', status: 'beauftragt' }),
      makeProject({ id: '7', status: 'angebot' }), // buffer, not counted in actionCounts
      makeProject({ id: '8', status: 'in_arbeit' }), // active, not counted
    ];

    const summary = computeSummary(projects, now);
    expect(summary.actionCounts['anfrage']).toBe(2);
    expect(summary.actionCounts['rechnung_faellig']).toBe(3);
    expect(summary.actionCounts['beauftragt']).toBe(1);

    // Finding 5: non-action states must NOT appear in actionCounts
    expect(summary.actionCounts['angebot']).toBeUndefined();
    expect(summary.actionCounts['in_arbeit']).toBeUndefined();
  });

  // UT-9: Correctly counts aged buffer items
  it('UT-9: correctly counts aged buffer items', () => {
    const now = new Date('2026-04-03T12:00:00Z');
    const projects: Project[] = [
      // Angebot threshold = 14 days
      makeProject({ id: '1', status: 'angebot', statusChangedAt: '2026-03-15T00:00:00Z' }), // 19 days — aged
      makeProject({ id: '2', status: 'angebot', statusChangedAt: '2026-03-25T00:00:00Z' }), // 9 days — not aged
      // Geplant threshold = 21 days
      makeProject({ id: '3', status: 'geplant', statusChangedAt: '2026-03-01T00:00:00Z' }), // 33 days — aged
      // Abnahme threshold = 7 days
      makeProject({ id: '4', status: 'abnahme', statusChangedAt: '2026-04-01T00:00:00Z' }), // 2 days — not aged
      // Abgerechnet threshold = 30 days
      makeProject({ id: '5', status: 'abgerechnet', statusChangedAt: '2026-02-20T00:00:00Z' }), // 42 days — aged
    ];

    const summary = computeSummary(projects, now);
    expect(summary.agedBufferCounts).toHaveLength(3);

    const angebotAged = summary.agedBufferCounts.find((a) => a.state === 'angebot');
    expect(angebotAged).toBeDefined();
    expect(angebotAged!.count).toBe(1);
    expect(angebotAged!.thresholdDays).toBe(14);

    const geplantAged = summary.agedBufferCounts.find((a) => a.state === 'geplant');
    expect(geplantAged).toBeDefined();
    expect(geplantAged!.count).toBe(1);

    const abgerechnetAged = summary.agedBufferCounts.find((a) => a.state === 'abgerechnet');
    expect(abgerechnetAged).toBeDefined();
    expect(abgerechnetAged!.count).toBe(1);
  });

  it('counts projects without dates correctly', () => {
    const now = new Date('2026-04-03T12:00:00Z');
    const projects: Project[] = [
      makeProject({ id: '1', status: 'anfrage' }), // no dates
      makeProject({ id: '2', status: 'angebot', plannedStart: '2026-04-10' }), // has start
      makeProject({ id: '3', status: 'beauftragt' }), // no dates
    ];

    const summary = computeSummary(projects, now);
    expect(summary.projectsWithoutDates).toBe(2);
  });
});
