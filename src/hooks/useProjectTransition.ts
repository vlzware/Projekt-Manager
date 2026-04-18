import { useState } from 'react';
import type { Project } from '@/domain/types';
import {
  canTransitionForward,
  canTransitionBackward,
  getNextState,
  getPreviousState,
} from '@/domain/transitions';
import { STATE_CONFIG_MAP } from '@/config/stateConfig';
import { STRINGS } from '@/config/strings';
import { useProjectStore } from '@/state/projectStore';
import { useConfirmStore } from '@/state/confirmStore';

export function useProjectTransition(project: Project) {
  const transitionForward = useProjectStore((s) => s.transitionForward);
  const transitionBackward = useProjectStore((s) => s.transitionBackward);
  const storeInFlight = useProjectStore((s) => !!s.mutationInFlight[project.id]);
  const config = STATE_CONFIG_MAP[project.status];

  // Local pending flag covers the `requestConfirm` window, which the
  // store's `mutationInFlight` does NOT — the store flag flips only
  // once the mutation actually dispatches. Without this, a second
  // click during the confirm dialog silently cancels the first
  // (useConfirmStore preempts in-flight requests) and re-opens a new
  // one, discarding the user's first action with no feedback.
  const [pending, setPending] = useState(false);

  const inFlight = pending || storeInFlight;

  return {
    canForward: canTransitionForward(project.status),
    canBackward: canTransitionBackward(project.status),
    inFlight,

    forward: async () => {
      if (inFlight) return;
      const next = getNextState(project.status);
      if (!next) return;
      const nextLabel = STATE_CONFIG_MAP[next].label;
      setPending(true);
      try {
        const confirmed = await useConfirmStore
          .getState()
          .request(STRINGS.projects.transitionConfirm(config.label, nextLabel));
        if (confirmed) {
          transitionForward(project.id);
        }
      } finally {
        setPending(false);
      }
    },

    backward: async () => {
      if (inFlight) return;
      const prev = getPreviousState(project.status);
      if (!prev) return;
      const prevLabel = STATE_CONFIG_MAP[prev].label;
      setPending(true);
      try {
        const confirmed = await useConfirmStore
          .getState()
          .request(STRINGS.projects.transitionConfirm(config.label, prevLabel));
        if (confirmed) {
          transitionBackward(project.id);
        }
      } finally {
        setPending(false);
      }
    },
  };
}
