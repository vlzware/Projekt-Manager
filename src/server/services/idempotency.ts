/**
 * Idempotency comparators for client-supplied create IDs.
 *
 * When a client POSTs a create with its own UUID, a retry after a lost
 * response can land on a row that already exists. We replay the create
 * (return the stored row with 201) iff the user-supplied fields match the
 * stored row exactly. A mismatch means the same id was used for a different
 * logical request — an error the client must reconcile.
 *
 * Audit fields (createdAt, updatedAt, createdBy, updatedBy) are excluded
 * from comparison: they are server-controlled.
 */

import type { WorkflowState } from '../../config/stateConfig.js';
import { formatDateOnly } from '../../domain/dateFormat.js';

export interface CustomerIncoming {
  name: string;
  phone?: string | null;
  email?: string | null;
  address?: { street: string; zip: string; city: string } | null;
  notes?: string | null;
}

export interface CustomerStored {
  name: string;
  phone: string | null;
  email: string | null;
  address: { street: string; zip: string; city: string } | null;
  notes: string | null;
}

function normalizeAddress(
  addr: { street: string; zip: string; city: string } | null | undefined,
): { street: string; zip: string; city: string } | null {
  if (!addr) return null;
  return { street: addr.street, zip: addr.zip, city: addr.city };
}

export function customerMatches(incoming: CustomerIncoming, stored: CustomerStored): boolean {
  if (incoming.name !== stored.name) return false;
  if ((incoming.phone ?? null) !== stored.phone) return false;
  if ((incoming.email ?? null) !== stored.email) return false;
  if ((incoming.notes ?? null) !== stored.notes) return false;

  const incAddr = normalizeAddress(incoming.address ?? null);
  const storedAddr = normalizeAddress(stored.address);
  if (incAddr === null && storedAddr === null) return true;
  if (incAddr === null || storedAddr === null) return false;
  return (
    incAddr.street === storedAddr.street &&
    incAddr.zip === storedAddr.zip &&
    incAddr.city === storedAddr.city
  );
}

export interface ProjectIncoming {
  number: string;
  title: string;
  customerId: string;
  status: WorkflowState;
  plannedStart?: string | null;
  plannedEnd?: string | null;
  assignedWorkerIds?: string[];
  estimatedValue?: number | null;
  notes?: string | null;
}

export interface ProjectStored {
  number: string;
  title: string;
  customerId: string;
  status: string;
  plannedStart: Date | null;
  plannedEnd: Date | null;
  assignedWorkerIds: string[];
  estimatedValue: string | null;
  notes: string | null;
}

function dateToIsoDay(d: Date | null): string | null {
  return d ? formatDateOnly(d) : null;
}

function sortedUnique(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}

/**
 * Compare two monetary values. Incoming is a JS number (`1234.5`), stored is
 * the Postgres numeric(12,2) text representation (`'1234.50'`). Round the
 * incoming value to 2 decimal places before compare — otherwise a first
 * POST with `1234.567` persists as `1234.57`, and a retry with the exact
 * same `1234.567` would read back `1234.57` and spuriously 409.
 * null/undefined on either side means "no value".
 */
function estimatedValueEq(incoming: number | null | undefined, stored: string | null): boolean {
  const inc = incoming == null ? null : Math.round(incoming * 100) / 100;
  const sto = stored == null ? null : Number.parseFloat(stored);
  if (inc === null && sto === null) return true;
  if (inc === null || sto === null) return false;
  return inc === sto;
}

export function projectMatches(incoming: ProjectIncoming, stored: ProjectStored): boolean {
  if (incoming.number !== stored.number) return false;
  if (incoming.title !== stored.title) return false;
  if (incoming.customerId !== stored.customerId) return false;
  if (incoming.status !== stored.status) return false;

  const incStart = incoming.plannedStart ?? null;
  const storedStart = dateToIsoDay(stored.plannedStart);
  if (incStart !== storedStart) return false;

  const incEnd = incoming.plannedEnd ?? null;
  const storedEnd = dateToIsoDay(stored.plannedEnd);
  if (incEnd !== storedEnd) return false;

  const incWorkers = sortedUnique(incoming.assignedWorkerIds ?? []);
  const storedWorkers = sortedUnique(stored.assignedWorkerIds);
  if (incWorkers.length !== storedWorkers.length) return false;
  for (let i = 0; i < incWorkers.length; i++) {
    if (incWorkers[i] !== storedWorkers[i]) return false;
  }

  if (!estimatedValueEq(incoming.estimatedValue, stored.estimatedValue)) return false;

  if ((incoming.notes ?? null) !== stored.notes) return false;
  return true;
}
