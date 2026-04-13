/**
 * Project repository — barrel re-export.
 *
 * Split into focused modules:
 *   project-read.ts        — listProjects, getProject, insertProject, toProject, ProjectRow
 *   project-transitions.ts — transitionForward, transitionBackward, TransitionError
 *   project-dates.ts       — updateDates, DateValidationError
 */

export {
  type ProjectRow,
  type ListProjectsOpts,
  toProject,
  listProjects,
  getProject,
  insertProject,
  updateProject,
  softDeleteProject,
  ProjectNotFoundError,
} from './project-read.js';
export {
  transitionForward,
  transitionBackward,
  TransitionError,
  ConcurrentModificationError,
} from './project-transitions.js';
export { updateDates, DateValidationError } from './project-dates.js';
