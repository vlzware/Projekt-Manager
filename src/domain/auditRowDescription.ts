/**
 * One-line German description of an audit row derived from `(action,
 * payload)`. Pure function — no React, no i18n runtime.
 *
 * See ui/workflow-views.md §8.4.1 and ui/management.md §8.13.1 for the
 * UX target:
 *   - "Status geändert: Geplant → In Arbeit" for forward transitions
 *   - "Termine aktualisiert" for date updates
 *   - "Mitarbeiter zugewiesen: Jan Nowak" when workers are added, etc.
 *
 * Falls back to the action label from `auditActionLabels.ts` when no
 * richer derivation applies — the config-layer mapping remains the
 * single source of truth for the German copy.
 */

import { STATE_CONFIG_MAP, type WorkflowState } from '@/config/stateConfig';
import { labelForAuditAction } from '@/config/auditActionLabels';
import { isPayloadDiff } from './audit';
import type { AuditEntityType } from './audit';

/**
 * Shape guard for the transition payload written by the server's
 * `mutate()` helper: `{ before: { status }, after: { status } }`. A
 * defensively narrow check — anything that doesn't match falls back
 * to the generic action label.
 */
function extractTransitionStates(
  payload: unknown,
): { from: WorkflowState; to: WorkflowState } | null {
  if (!isPayloadDiff(payload)) return null;
  const before = payload.before;
  const after = payload.after;
  const fromRaw = before?.status;
  const toRaw = after?.status;
  if (typeof fromRaw !== 'string' || typeof toRaw !== 'string') return null;
  if (!(fromRaw in STATE_CONFIG_MAP)) return null;
  if (!(toRaw in STATE_CONFIG_MAP)) return null;
  return { from: fromRaw as WorkflowState, to: toRaw as WorkflowState };
}

/**
 * Return a localized state label for a raw workflow-state key.
 * Typed so a caller who already narrowed to `WorkflowState` skips the
 * fallback branch.
 */
function stateLabel(state: WorkflowState): string {
  return STATE_CONFIG_MAP[state].label;
}

/**
 * Produce the one-line description. Recognizes a small set of
 * enriched shapes; otherwise delegates to `labelForAuditAction` so
 * the UI surface stays stable even for actions the client has not
 * specifically learned yet.
 */
export function describeAuditRow(args: {
  action: string;
  payload: unknown;
  entityType: AuditEntityType;
}): string {
  const { action, payload } = args;

  // Forward / backward transition — the two most visible actions in
  // the project-detail feed; worth a "from → to" rendering.
  if (action === 'transition:forward' || action === 'transition:backward') {
    const states = extractTransitionStates(payload);
    if (states) {
      return `Status geändert: ${stateLabel(states.from)} → ${stateLabel(states.to)}`;
    }
  }

  // Generic fallback — the action label alone, localized via the
  // config-layer mapping. Unknown actions surface their raw string (see
  // `labelForAuditAction` docstring).
  return labelForAuditAction(action);
}
