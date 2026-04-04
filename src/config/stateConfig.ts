export type WorkflowState =
  | 'anfrage'
  | 'angebot'
  | 'beauftragt'
  | 'geplant'
  | 'in_arbeit'
  | 'abnahme'
  | 'rechnung_faellig'
  | 'abgerechnet'
  | 'erledigt';

export type StateType = 'action' | 'buffer' | 'active' | 'done';

export interface StateConfig {
  key: WorkflowState;
  label: string;
  type: StateType;
  order: number;
  color: string;
  agingThresholdDays?: number;
  agingBoldDays?: number;
}

export const STATE_CONFIGS: StateConfig[] = [
  {
    key: 'anfrage',
    label: 'Anfrage',
    type: 'action',
    order: 1,
    color: '#F97316',
    agingBoldDays: 3,
  },
  {
    key: 'angebot',
    label: 'Angebot',
    type: 'buffer',
    order: 2,
    color: '#93C5FD',
    agingThresholdDays: 14,
    agingBoldDays: 14,
  },
  {
    key: 'beauftragt',
    label: 'Beauftragt',
    type: 'action',
    order: 3,
    color: '#F59E0B',
    agingBoldDays: 5,
  },
  {
    key: 'geplant',
    label: 'Geplant',
    type: 'buffer',
    order: 4,
    color: '#3B82F6',
    agingThresholdDays: 21,
    agingBoldDays: 21,
  },
  {
    key: 'in_arbeit',
    label: 'In Arbeit',
    type: 'active',
    order: 5,
    color: '#22C55E',
  },
  {
    key: 'abnahme',
    label: 'Abnahme',
    type: 'buffer',
    order: 6,
    color: '#14B8A6',
    agingThresholdDays: 7,
    agingBoldDays: 7,
  },
  {
    key: 'rechnung_faellig',
    label: 'Rechnung fällig',
    type: 'action',
    order: 7,
    color: '#EF4444',
    agingBoldDays: 3,
  },
  {
    key: 'abgerechnet',
    label: 'Abgerechnet',
    type: 'buffer',
    order: 8,
    color: '#6366F1',
    agingThresholdDays: 30,
    agingBoldDays: 30,
  },
  {
    key: 'erledigt',
    label: 'Erledigt',
    type: 'done',
    order: 9,
    color: '#9CA3AF',
  },
];

export const STATE_CONFIG_MAP: Record<WorkflowState, StateConfig> = Object.fromEntries(
  STATE_CONFIGS.map((config) => [config.key, config]),
) as Record<WorkflowState, StateConfig>;

export const WORKFLOW_ORDER: WorkflowState[] = STATE_CONFIGS.sort((a, b) => a.order - b.order).map(
  (c) => c.key,
);
