import type { WorkflowState } from '@/config/stateConfig';
import { WORKFLOW_ORDER } from '@/config/stateConfig';

export function getNextState(state: WorkflowState): WorkflowState | null {
  if (state === 'erledigt') return null;
  const index = WORKFLOW_ORDER.indexOf(state);
  if (index === -1 || index >= WORKFLOW_ORDER.length - 1) return null;
  return WORKFLOW_ORDER[index + 1];
}

export function getPreviousState(state: WorkflowState): WorkflowState | null {
  if (state === 'anfrage' || state === 'erledigt') return null;
  const index = WORKFLOW_ORDER.indexOf(state);
  if (index <= 0) return null;
  return WORKFLOW_ORDER[index - 1];
}

export function canTransitionForward(state: WorkflowState): boolean {
  return getNextState(state) !== null;
}

export function canTransitionBackward(state: WorkflowState): boolean {
  return getPreviousState(state) !== null;
}
