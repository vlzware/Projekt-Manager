import { STATE_CONFIG_MAP, STATE_CONFIGS } from '@/config/stateConfig';
import type { WorkflowState } from '@/config/stateConfig';
import type { Project, SummaryData } from './types';
import { isBufferAged } from './aging';

export function computeSummary(projects: Project[], now: Date = new Date()): SummaryData {
  const actionCounts: Partial<Record<WorkflowState, number>> = {};
  const agedBufferMap = new Map<WorkflowState, number>();
  let projectsWithoutDates = 0;

  // Initialize action state counts
  for (const config of STATE_CONFIGS) {
    if (config.type === 'action') {
      actionCounts[config.key] = 0;
    }
  }

  for (const project of projects) {
    const config = STATE_CONFIG_MAP[project.status];

    // Count action state projects
    if (config.type === 'action') {
      actionCounts[project.status] = (actionCounts[project.status] ?? 0) + 1;
    }

    // Count aged buffer projects
    if (config.type === 'buffer' && isBufferAged(project.status, project.statusChangedAt, now)) {
      agedBufferMap.set(project.status, (agedBufferMap.get(project.status) ?? 0) + 1);
    }

    // Count projects without dates
    if (!project.plannedStart && !project.plannedEnd) {
      projectsWithoutDates++;
    }
  }

  const agedBufferCounts = Array.from(agedBufferMap.entries()).map(([state, count]) => ({
    state,
    count,
    thresholdDays: STATE_CONFIG_MAP[state].agingThresholdDays!,
  }));

  return { actionCounts, agedBufferCounts, projectsWithoutDates };
}
