/**
 * Project service — barrel re-export.
 *
 * Split into focused services, following the repository-layer precedent
 * (`src/server/repositories/project.ts`):
 *   ProjectCrudService       — list/get/create/update/archive/purge + worker side effects
 *   ProjectTransitionService — forward/backward workflow transitions
 *   ProjectDatesService      — planned-start/planned-end updates
 */

export { ProjectCrudService } from './ProjectCrudService.js';
export { ProjectTransitionService } from './ProjectTransitionService.js';
export { ProjectDatesService } from './ProjectDatesService.js';
