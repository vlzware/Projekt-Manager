import type { WorkflowState } from '@/config/stateConfig';

export interface Project {
  id: string;
  number: string;
  title: string;
  status: WorkflowState;
  statusChangedAt: string;

  customer: {
    name: string;
    phone?: string;
    email?: string;
  };

  address?: {
    street: string;
    zip: string;
    city: string;
  };

  plannedStart?: string;
  plannedEnd?: string;

  assignedWorkers?: string[];
  estimatedValue?: number;
  notes?: string;

  createdAt: string;
  updatedAt: string;
}

export interface SummaryData {
  actionCounts: Partial<Record<WorkflowState, number>>;
  agedBufferCounts: { state: WorkflowState; count: number; thresholdDays: number }[];
  projectsWithoutDates: number;
}

export type ViewMode = 'kanban' | 'kalender';
