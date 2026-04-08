import type { Project } from '@/domain/types';
import {
  canTransitionForward,
  canTransitionBackward,
  getNextState,
  getPreviousState,
} from '@/domain/transitions';
import { STATE_CONFIG_MAP } from '@/config/stateConfig';
import { useProjectStore } from '@/state/projectStore';
import { useConfirmStore } from '@/state/confirmStore';

export function useProjectTransition(project: Project) {
  const transitionForward = useProjectStore((s) => s.transitionForward);
  const transitionBackward = useProjectStore((s) => s.transitionBackward);
  const inFlight = useProjectStore((s) => !!s.mutationInFlight[project.id]);
  const config = STATE_CONFIG_MAP[project.status];

  return {
    canForward: canTransitionForward(project.status),
    canBackward: canTransitionBackward(project.status),
    inFlight,

    forward: async () => {
      if (inFlight) return;
      const next = getNextState(project.status);
      if (!next) return;
      const nextLabel = STATE_CONFIG_MAP[next].label;
      const confirmed = await useConfirmStore
        .getState()
        .request(`Status ändern: ${config.label} → ${nextLabel}?`);
      if (confirmed) {
        transitionForward(project.id);
      }
    },

    backward: async () => {
      if (inFlight) return;
      const prev = getPreviousState(project.status);
      if (!prev) return;
      const prevLabel = STATE_CONFIG_MAP[prev].label;
      const confirmed = await useConfirmStore
        .getState()
        .request(`Status ändern: ${config.label} → ${prevLabel}?`);
      if (confirmed) {
        transitionBackward(project.id);
      }
    },
  };
}
