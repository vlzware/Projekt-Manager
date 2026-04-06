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
  createdBy?: string;
  updatedBy?: string;
}

export interface SummaryData {
  actionCounts: Partial<Record<WorkflowState, number>>;
  agedBufferCounts: { state: WorkflowState; count: number; thresholdDays: number }[];
  projectsWithoutDates: number;
}

/**
 * Available view modes. Extend this union and App.tsx when adding new views
 * (e.g., 'worker', 'bookkeeper'). See architecture.md §11.5.
 */
export type ViewMode = 'kanban' | 'kalender';
