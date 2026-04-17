/**
 * Seed business-data loader — customers, projects, project_workers.
 *
 * Unlike users, business data flows through the same import path that
 * serves `POST /api/import` (`ImportService.import`). The contract comes
 * from data-model.md §5.8 / §7 and ADR-0018: the seed exercises the
 * import envelope on every run, so format drift breaks the seed and the
 * public restore path together instead of only one or the other.
 *
 * The transformer (`buildBusinessEnvelope`) is pure and takes `now` as
 * the single reference moment — every relative date (and the project
 * number year prefix) is derived from it. Capturing `now` once fixes the
 * module-load-time `year` smell in the pre-refactor seed.ts.
 */
import { randomUUID } from 'node:crypto';

import type { Database } from '../db/connection.js';
import { ImportService } from '../services/ImportService.js';
import {
  SCHEMA_VERSION,
  type Envelope,
  type EnvelopeCustomer,
  type EnvelopeProject,
  type EnvelopeAssignment,
} from '../../domain/dataExchange.js';

import { daysFromNow } from './daysFromNow.js';
import { SEEDED_USER_IDS } from './users.js';

interface CustomerSpec {
  name: string;
  phone?: string;
  email?: string;
  address?: { street: string; zip: string; city: string };
  notes?: string;
}

interface ProjectSpec {
  numberSuffix: string; // e.g. '001' — year prefix is applied by the builder
  title: string;
  status: EnvelopeProject['status'];
  statusChangedAtDays: number;
  customerName: string;
  plannedStartDays?: number;
  plannedEndDays?: number;
  estimatedValue?: string;
  createdAtDays: number;
  updatedAtDays: number;
}

interface AssignmentSpec {
  projectNumberSuffix: string;
  username: 'arbeiter1' | 'arbeiter2';
}

// ---------------------------------------------------------------
// Customers (data-model.md §7.3 — 21 customers, mix of full/minimal)
// ---------------------------------------------------------------
const CUSTOMER_SPECS: readonly CustomerSpec[] = [
  {
    name: 'Familie Müller',
    phone: '+49 221 1234567',
    address: { street: 'Hauptstr. 12', zip: '51465', city: 'Bergisch Gladbach' },
  },
  {
    name: 'Firma Weber GmbH',
    email: 'info@weber-gmbh.de',
  },
  {
    name: 'Schmidt Hausverwaltung',
    phone: '+49 221 9876543',
    address: { street: 'Kölner Str. 45', zip: '51429', city: 'Bergisch Gladbach' },
  },
  {
    name: 'Weber Immobilien',
    phone: '+49 2202 54321',
    address: { street: 'Industriestr. 8', zip: '51399', city: 'Burscheid' },
  },
  {
    name: 'Familie Becker',
    phone: '+49 221 7654321',
    address: { street: 'Am Graben 7', zip: '51467', city: 'Bergisch Gladbach' },
  },
  {
    name: 'Herr Schneider',
    // Minimal — no phone, email, or address
  },
  {
    name: 'Evangelische Gemeinde Refrath',
    phone: '+49 2204 12345',
    address: { street: 'Kirchweg 3', zip: '51427', city: 'Bergisch Gladbach' },
  },
  {
    name: 'Frau Klein',
    phone: '+49 221 3456789',
    address: { street: 'Rosenweg 15', zip: '51469', city: 'Bergisch Gladbach' },
  },
  {
    name: 'Dr. Braun Zahnarztpraxis',
    phone: '+49 2204 67890',
    address: { street: 'Bahnhofstr. 22', zip: '51427', city: 'Bergisch Gladbach' },
  },
  {
    name: 'Familie Hoffmann',
    address: { street: 'Lindenallee 5', zip: '51465', city: 'Bergisch Gladbach' },
  },
  {
    name: 'Café Sonnenschein GbR',
    email: 'info@cafe-sonnenschein.de',
    address: { street: 'Marktplatz 1', zip: '51429', city: 'Bergisch Gladbach' },
  },
  {
    name: 'Herr Wagner',
    phone: '+49 221 8765432',
    address: { street: 'Paffrather Str. 88', zip: '51469', city: 'Bergisch Gladbach' },
  },
  {
    name: 'Stadt Bergisch Gladbach',
    email: 'vergabe@stadt-gl.de',
    address: { street: 'Schulstr. 12', zip: '51465', city: 'Bergisch Gladbach' },
  },
  {
    name: 'Autohaus Kramer GmbH',
    phone: '+49 2202 11111',
    address: { street: 'Gewerbepark 4', zip: '51399', city: 'Burscheid' },
  },
  {
    name: 'Herr Peters',
    // Minimal — no address
  },
  {
    name: 'Rheinisch-Bergischer Kreis',
    email: 'bau@rbk-online.de',
    address: { street: 'Schulweg 20', zip: '51465', city: 'Bergisch Gladbach' },
  },
  {
    name: 'Metzgerei Frank',
    phone: '+49 221 2222222',
    address: { street: 'Hauptstr. 55', zip: '51465', city: 'Bergisch Gladbach' },
  },
  {
    name: 'Familie Richter',
    phone: '+49 2204 33333',
    address: { street: 'Birkenweg 9', zip: '51427', city: 'Bergisch Gladbach' },
  },
  {
    name: 'Kanzlei Dr. Meier',
    email: 'kanzlei@dr-meier.de',
    // No address
  },
  // Customers with no projects yet (spec §7.3)
  {
    name: 'Schulz & Partner PartG',
    phone: '+49 221 4444444',
    notes: 'Kontakt über Empfehlung',
  },
  {
    name: 'Monika Engel',
    notes: 'Import aus externem System',
  },
];

// ---------------------------------------------------------------
// Projects (data-model.md §7.1 — 19 projects across all 9 states)
// ---------------------------------------------------------------
const PROJECT_SPECS: readonly ProjectSpec[] = [
  // Anfrage (2) — recent, no dates planned
  {
    numberSuffix: '001',
    title: 'Fassadenanstrich Müller',
    status: 'anfrage',
    statusChangedAtDays: -1,
    customerName: 'Familie Müller',
    createdAtDays: -1,
    updatedAtDays: -1,
  },
  {
    numberSuffix: '002',
    title: 'Innenraumgestaltung Weber',
    status: 'anfrage',
    statusChangedAtDays: -10,
    customerName: 'Firma Weber GmbH',
    createdAtDays: -10,
    updatedAtDays: -10,
  },
  // Angebot (2) — one fresh, one stale
  {
    numberSuffix: '003',
    title: 'Treppenhaussanierung Schmidt',
    status: 'angebot',
    statusChangedAtDays: -3,
    customerName: 'Schmidt Hausverwaltung',
    estimatedValue: '8500.00',
    createdAtDays: -5,
    updatedAtDays: -3,
  },
  {
    numberSuffix: '004',
    title: 'Malerarbeiten Bürokomplex Weber',
    status: 'angebot',
    statusChangedAtDays: -18,
    customerName: 'Weber Immobilien',
    estimatedValue: '24000.00',
    createdAtDays: -20,
    updatedAtDays: -18,
  },
  // Beauftragt (2) — confirmed, no dates
  {
    numberSuffix: '005',
    title: 'Kellerdeckendämmung Becker',
    status: 'beauftragt',
    statusChangedAtDays: -4,
    customerName: 'Familie Becker',
    estimatedValue: '3200.00',
    createdAtDays: -8,
    updatedAtDays: -4,
  },
  {
    numberSuffix: '006',
    title: 'Fensteranstrich Schneider',
    status: 'beauftragt',
    statusChangedAtDays: -2,
    customerName: 'Herr Schneider',
    createdAtDays: -6,
    updatedAtDays: -2,
  },
  // Geplant (2) — dates assigned
  {
    numberSuffix: '007',
    title: 'Fassadensanierung Gemeindezentrum',
    status: 'geplant',
    statusChangedAtDays: -7,
    customerName: 'Evangelische Gemeinde Refrath',
    plannedStartDays: 5,
    plannedEndDays: 12,
    estimatedValue: '18500.00',
    createdAtDays: -14,
    updatedAtDays: -7,
  },
  {
    numberSuffix: '008',
    title: 'Wohnungsrenovierung Klein',
    status: 'geplant',
    statusChangedAtDays: -3,
    customerName: 'Frau Klein',
    plannedStartDays: 8,
    plannedEndDays: 10,
    estimatedValue: '4800.00',
    createdAtDays: -10,
    updatedAtDays: -3,
  },
  // In Arbeit (3) — currently on-site
  {
    numberSuffix: '009',
    title: 'Malerarbeiten Praxis Dr. Braun',
    status: 'in_arbeit',
    statusChangedAtDays: -5,
    customerName: 'Dr. Braun Zahnarztpraxis',
    plannedStartDays: -5,
    plannedEndDays: 2,
    estimatedValue: '12000.00',
    createdAtDays: -18,
    updatedAtDays: -5,
  },
  {
    numberSuffix: '010',
    title: 'Lackierung Treppengeländer Hoffmann',
    status: 'in_arbeit',
    statusChangedAtDays: -3,
    customerName: 'Familie Hoffmann',
    plannedStartDays: -3,
    plannedEndDays: -1, // slightly past end — edge case
    estimatedValue: '2800.00',
    createdAtDays: -12,
    updatedAtDays: -3,
  },
  {
    numberSuffix: '011',
    title: 'Tapezierarbeiten Café Sonnenschein',
    status: 'in_arbeit',
    statusChangedAtDays: -2,
    customerName: 'Café Sonnenschein GbR',
    plannedStartDays: -2,
    plannedEndDays: 1,
    estimatedValue: '6500.00',
    createdAtDays: -15,
    updatedAtDays: -2,
  },
  // Abnahme (1) — waiting for customer walk-through
  {
    numberSuffix: '012',
    title: 'Außenanstrich Reihenhaus Wagner',
    status: 'abnahme',
    statusChangedAtDays: -1,
    customerName: 'Herr Wagner',
    plannedStartDays: -10,
    plannedEndDays: -2,
    estimatedValue: '7200.00',
    createdAtDays: -21,
    updatedAtDays: -1,
  },
  // Rechnung fällig (3) — critical accumulation
  {
    numberSuffix: '013',
    title: 'Malerarbeiten Kita Sonnenkäfer',
    status: 'rechnung_faellig',
    statusChangedAtDays: -2,
    customerName: 'Stadt Bergisch Gladbach',
    plannedStartDays: -20,
    plannedEndDays: -5,
    estimatedValue: '15000.00',
    createdAtDays: -25,
    updatedAtDays: -2,
  },
  {
    numberSuffix: '014',
    title: 'Bodenbeschichtung Autohaus Kramer',
    status: 'rechnung_faellig',
    statusChangedAtDays: -5,
    customerName: 'Autohaus Kramer GmbH',
    estimatedValue: '9800.00',
    createdAtDays: -28,
    updatedAtDays: -5,
  },
  {
    numberSuffix: '015',
    title: 'Anstrich Gartenlaube Peters',
    status: 'rechnung_faellig',
    statusChangedAtDays: -8,
    customerName: 'Herr Peters',
    estimatedValue: '1200.00',
    createdAtDays: -22,
    updatedAtDays: -8,
  },
  // Abgerechnet (2) — invoice sent, waiting for payment
  {
    numberSuffix: '016',
    title: 'Fassadenanstrich Schule am Park',
    status: 'abgerechnet',
    statusChangedAtDays: -3,
    customerName: 'Rheinisch-Bergischer Kreis',
    plannedStartDays: -28,
    plannedEndDays: -15,
    estimatedValue: '32000.00',
    createdAtDays: -30,
    updatedAtDays: -3,
  },
  {
    numberSuffix: '017',
    title: 'Lackierarbeiten Türen Metzgerei Frank',
    status: 'abgerechnet',
    statusChangedAtDays: -6,
    customerName: 'Metzgerei Frank',
    estimatedValue: '3600.00',
    createdAtDays: -24,
    updatedAtDays: -6,
  },
  // Erledigt (2) — completed and paid
  {
    numberSuffix: '018',
    title: 'Malerarbeiten Neubau Richter',
    status: 'erledigt',
    statusChangedAtDays: -5,
    customerName: 'Familie Richter',
    plannedStartDays: -25,
    plannedEndDays: -12,
    estimatedValue: '21000.00',
    createdAtDays: -28,
    updatedAtDays: -5,
  },
  {
    numberSuffix: '019',
    title: 'Wandgestaltung Kanzlei Dr. Meier',
    status: 'erledigt',
    statusChangedAtDays: -10,
    customerName: 'Kanzlei Dr. Meier',
    estimatedValue: '5400.00',
    createdAtDays: -26,
    updatedAtDays: -10,
  },
];

// ---------------------------------------------------------------
// Project–Worker assignments (7 rows)
// ---------------------------------------------------------------
const ASSIGNMENT_SPECS: readonly AssignmentSpec[] = [
  // Geplant
  { projectNumberSuffix: '007', username: 'arbeiter1' },
  { projectNumberSuffix: '007', username: 'arbeiter2' },
  { projectNumberSuffix: '008', username: 'arbeiter1' },
  // In Arbeit
  { projectNumberSuffix: '009', username: 'arbeiter1' },
  { projectNumberSuffix: '009', username: 'arbeiter2' },
  { projectNumberSuffix: '010', username: 'arbeiter2' },
  { projectNumberSuffix: '011', username: 'arbeiter1' },
];

/**
 * Build the in-memory envelope that represents the seed's business data.
 * Pure — given the same `now` the output is byte-equal. Dates are ISO
 * strings because `EnvelopeCustomer` / `EnvelopeProject` declare them
 * that way (`ImportService.toXxxInsert` parses them back to `Date`).
 */
export function buildBusinessEnvelope(now: Date): Envelope {
  const year = now.getFullYear();
  const nowIso = now.toISOString();

  // Customers first — projects reference customers by id.
  const customerById = new Map<string, EnvelopeCustomer>();
  const customerIdByName = new Map<string, string>();
  for (const spec of CUSTOMER_SPECS) {
    const id = randomUUID();
    const customer: EnvelopeCustomer = {
      id,
      name: spec.name,
      phone: spec.phone ?? null,
      email: spec.email ?? null,
      address: spec.address ?? null,
      notes: spec.notes ?? null,
      createdAt: nowIso,
      updatedAt: nowIso,
      createdBy: null,
      updatedBy: null,
    };
    customerById.set(id, customer);
    customerIdByName.set(spec.name, id);
  }

  // Projects carry the year prefix derived from `now` — not from a
  // module-load-time capture. Dates are produced via the shared
  // `daysFromNow(now, d)` helper so every offset uses the same base.
  const projectById = new Map<string, EnvelopeProject>();
  const projectIdBySuffix = new Map<string, string>();
  for (const spec of PROJECT_SPECS) {
    const customerId = customerIdByName.get(spec.customerName);
    if (customerId === undefined) {
      throw new Error(
        `Seed business-envelope bug: project '${spec.numberSuffix}' references unknown customer '${spec.customerName}'`,
      );
    }
    const id = randomUUID();
    const project: EnvelopeProject = {
      id,
      number: `${year}-${spec.numberSuffix}`,
      title: spec.title,
      status: spec.status,
      statusChangedAt: daysFromNow(now, spec.statusChangedAtDays).toISOString(),
      customerId,
      plannedStart:
        spec.plannedStartDays === undefined
          ? null
          : daysFromNow(now, spec.plannedStartDays).toISOString(),
      plannedEnd:
        spec.plannedEndDays === undefined
          ? null
          : daysFromNow(now, spec.plannedEndDays).toISOString(),
      estimatedValue: spec.estimatedValue ?? null,
      notes: null,
      deleted: false,
      createdAt: daysFromNow(now, spec.createdAtDays).toISOString(),
      updatedAt: daysFromNow(now, spec.updatedAtDays).toISOString(),
      createdBy: null,
      updatedBy: null,
    };
    projectById.set(id, project);
    projectIdBySuffix.set(spec.numberSuffix, id);
  }

  const assignments: EnvelopeAssignment[] = ASSIGNMENT_SPECS.map((a) => {
    const projectId = projectIdBySuffix.get(a.projectNumberSuffix);
    if (projectId === undefined) {
      throw new Error(
        `Seed business-envelope bug: assignment references unknown project suffix '${a.projectNumberSuffix}'`,
      );
    }
    const userId = SEEDED_USER_IDS[a.username]!;
    return { projectId, userId };
  });

  return {
    schema_version: SCHEMA_VERSION,
    exported_at: nowIso,
    customers: Array.from(customerById.values()),
    projects: Array.from(projectById.values()),
    project_workers: assignments,
  };
}

/**
 * Build and apply the business envelope via `ImportService`. Mirrors the
 * constructor pattern in `src/server/routes/data-exchange.ts`. The target
 * is guaranteed empty by the orchestrator's TRUNCATE, so the safe path
 * (`override: false`, `confirmationPhrase: null`) succeeds.
 */
export async function loadBusiness(db: Database, opts: { now?: Date } = {}): Promise<void> {
  const now = opts.now ?? new Date();
  const envelope = buildBusinessEnvelope(now);
  const importService = new ImportService(db);
  await importService.import(envelope, {
    dryRun: false,
    override: false,
    confirmationPhrase: null,
  });
}
