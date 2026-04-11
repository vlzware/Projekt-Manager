import type { Project } from '@/domain/types';

/**
 * Factory + named exports for test project fixtures.
 *
 * Design (M7): replaces the prior 326-line hand-authored flat array. The
 * factory `buildProject` gives tests that don't care about specific IDs a
 * one-liner with sensible defaults. Named exports (`p01`..`p19`) preserve
 * identities that component tests assert on by ID and hydrate stores via
 * `[...mockProjects]`. The `mockProjects` array is a thin wrapper over the
 * named constants so existing consumers keep working.
 *
 * Rationale for keeping named fixtures:
 * - Several tests assert specific aging / sort behavior that depends on
 *   pre-configured statusChangedAt offsets (e.g., the KanbanBoard card sort
 *   test for rechnung_faellig requires p15=8d, p13=5d, p14=2d).
 * - DetailPanel AC-4 asserts specific field values for p09 (phone, email,
 *   address, workers, estimatedValue, notes). Inlining that into the test
 *   would move the fixture, not remove it.
 * - The Summary counts test relies on the aggregate distribution: 2 anfrage,
 *   2 angebot, 2 beauftragt, 2 geplant, 3 in_arbeit, 1 abnahme, 3
 *   rechnung_faellig, 2 abgerechnet, 2 erledigt.
 *
 * Dates are computed relative to "now" via helpers so tests don't go stale
 * as the clock advances.
 */

function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0] + 'T00:00:00.000Z';
}

function daysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function today(): string {
  return new Date().toISOString().split('T')[0];
}

let sequence = 0;

/**
 * Build a Project fixture with sensible defaults. Pass `overrides` for the
 * fields the test cares about. The `id` and `number` are sequenced so calls
 * without explicit overrides never collide.
 *
 * Defaults:
 * - status: 'anfrage' (no planned dates, no aging concerns)
 * - customer.name: 'Test Customer GmbH'
 * - createdAt / updatedAt: today
 * - statusChangedAt: today
 *
 * All optional fields (phone, email, address, plannedStart, plannedEnd,
 * assignedWorkers, estimatedValue, notes, createdBy, updatedBy) are omitted
 * by default; callers opt in via overrides.
 */
export function buildProject(overrides: Partial<Project> = {}): Project {
  sequence += 1;
  const seqId = String(sequence).padStart(3, '0');
  return {
    id: `test-${seqId}`,
    number: `2026-${seqId}`,
    title: 'Test project',
    status: 'anfrage',
    statusChangedAt: daysAgo(0),
    customer: { name: 'Test Customer GmbH' },
    address: null,
    plannedStart: null,
    plannedEnd: null,
    assignedWorkers: null,
    estimatedValue: null,
    notes: null,
    createdAt: daysAgo(0),
    updatedAt: daysAgo(0),
    createdBy: null,
    updatedBy: null,
    ...overrides,
  };
}

// === ANFRAGE (2) ===
export const p01: Project = Object.freeze(
  buildProject({
    id: 'p01',
    number: '2026-051',
    title: 'Fassadenanstrich Müller',
    statusChangedAt: daysAgo(1),
    customer: { name: 'Familie Müller', phone: '+49 221 1234567', email: 'mueller@example.de' },
    address: { street: 'Hauptstr. 12', zip: '51465', city: 'Bergisch Gladbach' },
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
  }),
);

export const p02: Project = Object.freeze(
  buildProject({
    id: 'p02',
    number: '2026-042',
    title: 'Treppenhaussanierung Schmidt',
    statusChangedAt: daysAgo(10),
    customer: {
      name: 'Schmidt Hausverwaltung',
      phone: '+49 221 9876543',
      email: 'schmidt@example.de',
    },
    address: { street: 'Kölner Str. 45', zip: '50999', city: 'Köln' },
    createdAt: daysAgo(10),
    updatedAt: daysAgo(10),
    notes: 'Dringend — Mieter beschweren sich über Zustand.',
  }),
);

// === ANGEBOT (2) ===
export const p03: Project = Object.freeze(
  buildProject({
    id: 'p03',
    number: '2026-040',
    title: 'Büroräume streichen Weber',
    status: 'angebot',
    statusChangedAt: daysAgo(3),
    customer: {
      name: 'Weber & Partner GmbH',
      phone: '+49 221 5551234',
      email: 'weber@example.de',
    },
    address: { street: 'Industriestr. 8', zip: '51063', city: 'Köln' },
    plannedStart: daysFromNow(14),
    plannedEnd: daysFromNow(17),
    estimatedValue: 8500,
    createdAt: daysAgo(7),
    updatedAt: daysAgo(3),
  }),
);

export const p04: Project = Object.freeze(
  buildProject({
    id: 'p04',
    number: '2026-035',
    title: 'Fensterlackierung Becker',
    status: 'angebot',
    statusChangedAt: daysAgo(18),
    customer: { name: 'Familie Becker', phone: '+49 2202 334455' },
    address: { street: 'Am Markt 3', zip: '51429', city: 'Bergisch Gladbach' },
    plannedStart: daysFromNow(21),
    estimatedValue: 3200,
    createdAt: daysAgo(20),
    updatedAt: daysAgo(18),
  }),
);

// === BEAUFTRAGT (2) ===
export const p05: Project = Object.freeze(
  buildProject({
    id: 'p05',
    number: '2026-038',
    title: 'Kellerdecke dämmen Fischer',
    status: 'beauftragt',
    statusChangedAt: daysAgo(4),
    customer: { name: 'Familie Fischer', phone: '+49 2203 112233', email: 'fischer@example.de' },
    address: { street: 'Gartenweg 7', zip: '51469', city: 'Bergisch Gladbach' },
    estimatedValue: 4800,
    createdAt: daysAgo(14),
    updatedAt: daysAgo(4),
  }),
);

export const p06: Project = Object.freeze(
  buildProject({
    id: 'p06',
    number: '2026-039',
    title: 'Malerarbeiten Neubau Yilmaz',
    status: 'beauftragt',
    statusChangedAt: daysAgo(2),
    customer: { name: 'Yilmaz Bau GmbH' },
    estimatedValue: 12000,
    createdAt: daysAgo(8),
    updatedAt: daysAgo(2),
  }),
);

// === GEPLANT (2) ===
export const p07: Project = Object.freeze(
  buildProject({
    id: 'p07',
    number: '2026-034',
    title: 'Wohnzimmer renovieren Klein',
    status: 'geplant',
    statusChangedAt: daysAgo(6),
    customer: { name: 'Familie Klein', phone: '+49 221 7778899', email: 'klein@example.de' },
    address: { street: 'Rosenstr. 15', zip: '50968', city: 'Köln' },
    plannedStart: daysFromNow(3),
    plannedEnd: daysFromNow(5),
    assignedWorkers: [
      { userId: 'u-braun', displayName: 'Thomas Braun' },
      { userId: 'u-scholz', displayName: 'Markus Scholz' },
    ],
    estimatedValue: 5500,
    createdAt: daysAgo(18),
    updatedAt: daysAgo(6),
  }),
);

export const p08: Project = Object.freeze(
  buildProject({
    id: 'p08',
    number: '2026-033',
    title: 'Außenanstrich Praxis Dr. Hoffmann',
    status: 'geplant',
    statusChangedAt: daysAgo(8),
    customer: { name: 'Dr. Hoffmann', phone: '+49 221 4443322', email: 'hoffmann@example.de' },
    address: { street: 'Bonner Str. 112', zip: '50677', city: 'Köln' },
    plannedStart: daysFromNow(7),
    plannedEnd: daysFromNow(10),
    assignedWorkers: [
      { userId: 'u-richter', displayName: 'Andreas Richter' },
      { userId: 'u-wolf', displayName: 'Stefan Wolf' },
    ],
    estimatedValue: 9200,
    createdAt: daysAgo(22),
    updatedAt: daysAgo(8),
  }),
);

// === IN ARBEIT (3) ===
export const p09: Project = Object.freeze(
  buildProject({
    id: 'p09',
    number: '2026-028',
    title: 'Malerarbeiten Bürokomplex Weber',
    status: 'in_arbeit',
    statusChangedAt: daysAgo(5),
    customer: {
      name: 'Weber Immobilien AG',
      phone: '+49 221 6665544',
      email: 'immobilien@weber.de',
    },
    address: { street: 'Rheinuferstr. 20', zip: '50668', city: 'Köln' },
    plannedStart: daysAgo(5),
    plannedEnd: daysFromNow(9),
    assignedWorkers: [
      { userId: 'u-braun', displayName: 'Thomas Braun' },
      { userId: 'u-scholz', displayName: 'Markus Scholz' },
      { userId: 'u-richter', displayName: 'Andreas Richter' },
      { userId: 'u-wolf', displayName: 'Stefan Wolf' },
    ],
    estimatedValue: 24000,
    createdAt: daysAgo(35),
    updatedAt: daysAgo(1),
    notes: 'Großprojekt — 3 Etagen. Aufzug nur Mo/Mi/Fr verfügbar.',
  }),
);

export const p10: Project = Object.freeze(
  buildProject({
    id: 'p10',
    number: '2026-030',
    title: 'Kinderzimmer streichen Pohl',
    status: 'in_arbeit',
    statusChangedAt: daysAgo(2),
    customer: { name: 'Familie Pohl', phone: '+49 2202 998877' },
    address: { street: 'Waldweg 22', zip: '51427', city: 'Bergisch Gladbach' },
    plannedStart: daysAgo(2),
    plannedEnd: today(),
    assignedWorkers: [{ userId: 'u-wolf', displayName: 'Stefan Wolf' }],
    estimatedValue: 1800,
    createdAt: daysAgo(12),
    updatedAt: daysAgo(2),
  }),
);

export const p11: Project = Object.freeze(
  buildProject({
    id: 'p11',
    number: '2026-029',
    title: 'Lackierung Geländer Schulze',
    status: 'in_arbeit',
    statusChangedAt: daysAgo(4),
    customer: { name: 'Schulze GbR', email: 'schulze@example.de' },
    address: { street: 'Berliner Str. 55', zip: '51063', city: 'Köln' },
    plannedStart: daysAgo(4),
    plannedEnd: daysAgo(1),
    assignedWorkers: [{ userId: 'u-scholz', displayName: 'Markus Scholz' }],
    estimatedValue: 2200,
    createdAt: daysAgo(15),
    updatedAt: daysAgo(1),
    notes: 'Leicht über Zeitplan — Wetter hat Außenarbeiten verzögert.',
  }),
);

// === ABNAHME (1) ===
export const p12: Project = Object.freeze(
  buildProject({
    id: 'p12',
    number: '2026-025',
    title: 'Fassade Mehrfamilienhaus Braun',
    status: 'abnahme',
    statusChangedAt: daysAgo(3),
    customer: { name: 'Braun Immobilien', phone: '+49 221 2223344', email: 'braun@example.de' },
    address: { street: 'Aachener Str. 200', zip: '50931', city: 'Köln' },
    plannedStart: daysAgo(15),
    plannedEnd: daysAgo(4),
    assignedWorkers: [
      { userId: 'u-braun', displayName: 'Thomas Braun' },
      { userId: 'u-richter', displayName: 'Andreas Richter' },
    ],
    estimatedValue: 15500,
    createdAt: daysAgo(40),
    updatedAt: daysAgo(3),
  }),
);

// === RECHNUNG FÄLLIG (3) — critical accumulation ===
// The KanbanBoard card-sort test depends on these specific statusChangedAt
// offsets: p15=8d (oldest), p13=5d, p14=2d (newest). Do not rearrange
// without updating `KanbanBoard.test.tsx` Card Sort Order spec.
export const p13: Project = Object.freeze(
  buildProject({
    id: 'p13',
    number: '2026-022',
    title: 'Treppenhausrenovierung Meyer',
    status: 'rechnung_faellig',
    statusChangedAt: daysAgo(5),
    customer: {
      name: 'Meyer Hausverwaltung',
      phone: '+49 221 8889900',
      email: 'meyer@example.de',
    },
    address: { street: 'Zülpicher Str. 88', zip: '50937', city: 'Köln' },
    plannedStart: daysAgo(25),
    plannedEnd: daysAgo(18),
    assignedWorkers: [
      { userId: 'u-braun', displayName: 'Thomas Braun' },
      { userId: 'u-wolf', displayName: 'Stefan Wolf' },
    ],
    estimatedValue: 7800,
    createdAt: daysAgo(45),
    updatedAt: daysAgo(5),
  }),
);

export const p14: Project = Object.freeze(
  buildProject({
    id: 'p14',
    number: '2026-020',
    title: 'Anstrich Gartenhaus Lorenz',
    status: 'rechnung_faellig',
    statusChangedAt: daysAgo(2),
    customer: { name: 'Familie Lorenz', phone: '+49 2203 556677' },
    address: { street: 'Schillerstr. 4', zip: '51469', city: 'Bergisch Gladbach' },
    plannedStart: daysAgo(14),
    plannedEnd: daysAgo(12),
    estimatedValue: 2400,
    createdAt: daysAgo(28),
    updatedAt: daysAgo(2),
  }),
);

export const p15: Project = Object.freeze(
  buildProject({
    id: 'p15',
    number: '2026-018',
    title: 'Badezimmer Spachteln Engel',
    status: 'rechnung_faellig',
    statusChangedAt: daysAgo(8),
    customer: { name: 'Familie Engel', email: 'engel@example.de' },
    address: { street: 'Mozartstr. 11', zip: '50674', city: 'Köln' },
    plannedStart: daysAgo(20),
    plannedEnd: daysAgo(16),
    estimatedValue: 3100,
    createdAt: daysAgo(30),
    updatedAt: daysAgo(8),
  }),
);

// === ABGERECHNET (2) ===
export const p16: Project = Object.freeze(
  buildProject({
    id: 'p16',
    number: '2026-015',
    title: 'Deckensanierung Schröder',
    status: 'abgerechnet',
    statusChangedAt: daysAgo(10),
    customer: {
      name: 'Familie Schröder',
      phone: '+49 221 1112233',
      email: 'schroeder@example.de',
    },
    address: { street: 'Luxemburger Str. 33', zip: '50674', city: 'Köln' },
    plannedStart: daysAgo(40),
    plannedEnd: daysAgo(35),
    estimatedValue: 6300,
    createdAt: daysAgo(55),
    updatedAt: daysAgo(10),
  }),
);

export const p17: Project = Object.freeze(
  buildProject({
    id: 'p17',
    number: '2026-012',
    title: 'Treppengeländer lackieren Nowak',
    status: 'abgerechnet',
    statusChangedAt: daysAgo(5),
    customer: { name: 'Nowak & Söhne', phone: '+49 2202 445566' },
    address: { street: 'Düsseldorfer Str. 78', zip: '51429', city: 'Bergisch Gladbach' },
    plannedStart: daysAgo(25),
    plannedEnd: daysAgo(22),
    estimatedValue: 4100,
    createdAt: daysAgo(38),
    updatedAt: daysAgo(5),
  }),
);

// === ERLEDIGT (2) ===
export const p18: Project = Object.freeze(
  buildProject({
    id: 'p18',
    number: '2026-008',
    title: 'Innenanstrich Gaststätte Krüger',
    status: 'erledigt',
    statusChangedAt: daysAgo(3),
    customer: {
      name: 'Krüger Gastronomie GmbH',
      phone: '+49 221 3334455',
      email: 'krueger@example.de',
    },
    address: { street: 'Severinstr. 199', zip: '50678', city: 'Köln' },
    plannedStart: daysAgo(30),
    plannedEnd: daysAgo(25),
    estimatedValue: 11200,
    createdAt: daysAgo(50),
    updatedAt: daysAgo(3),
  }),
);

export const p19: Project = Object.freeze(
  buildProject({
    id: 'p19',
    number: '2026-005',
    title: 'Fassadenreinigung Schmitz',
    status: 'erledigt',
    statusChangedAt: daysAgo(7),
    customer: { name: 'Schmitz Verwaltung', email: 'schmitz@example.de' },
    address: { street: 'Venloer Str. 400', zip: '50825', city: 'Köln' },
    plannedStart: daysAgo(35),
    plannedEnd: daysAgo(32),
    estimatedValue: 5800,
    createdAt: daysAgo(55),
    updatedAt: daysAgo(7),
  }),
);

/**
 * Full mock dataset: 19 projects distributed across all 9 workflow states.
 *
 * Edge cases covered:
 * - Projects without planned dates (p01, p02, p05, p06)
 * - Project with only plannedStart, no plannedEnd (p04)
 * - Projects exceeding aging thresholds (p02, p04)
 * - Multi-week project (p09)
 * - Minimal data project (p06 — no address, no phone, no workers)
 */
export const mockProjects: Project[] = [
  p01,
  p02,
  p03,
  p04,
  p05,
  p06,
  p07,
  p08,
  p09,
  p10,
  p11,
  p12,
  p13,
  p14,
  p15,
  p16,
  p17,
  p18,
  p19,
];

// All named fixtures (p01..p19) override `id` and `number` explicitly, so the
// `sequence` counter only matters for direct `buildProject({})` callers. Reset
// it here — after the named exports have consumed it during module load — so
// the first ad-hoc caller in any test starts at 1, regardless of how many
// named fixtures live in this file.
//
// TODO: this is still imperfect — module init order is the only barrier, and
// concurrent imports across worker threads share the counter only within a
// worker. If a future test asserts a specific generated id from `buildProject`,
// switch to `crypto.randomUUID().slice(0, 8)` for true call-site isolation.
sequence = 0;
