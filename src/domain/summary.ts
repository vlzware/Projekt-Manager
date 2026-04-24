import { STATE_CONFIG_MAP } from '@/config/stateConfig';
import type { WorkflowState } from '@/config/stateConfig';
import type { Project, SummaryData } from './types';
import { isBufferAged } from './aging';

export function computeSummary(projects: Project[], now: Date = new Date()): SummaryData {
  const agedBufferMap = new Map<WorkflowState, number>();
  let projectsWithoutDates = 0;

  for (const project of projects) {
    const config = STATE_CONFIG_MAP[project.status];

    if (config.type === 'buffer' && isBufferAged(project.status, project.statusChangedAt, now)) {
      agedBufferMap.set(project.status, (agedBufferMap.get(project.status) ?? 0) + 1);
    }

    if (!project.plannedStart && !project.plannedEnd) {
      projectsWithoutDates++;
    }
  }

  const agedBufferCounts = Array.from(agedBufferMap.entries()).map(([state, count]) => ({
    state,
    count,
    thresholdDays: STATE_CONFIG_MAP[state].agingThresholdDays!,
  }));

  return { agedBufferCounts, projectsWithoutDates };
}
