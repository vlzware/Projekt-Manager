import type { Project } from '@/domain/types';

/**
 * Mock dataset: 19 projects distributed across all 9 workflow states.
 * Dates are relative to a base date (roughly "now") to ensure aging
 * scenarios work correctly for demonstrations.
 *
 * Edge cases covered:
 * - Projects without planned dates (id: p01, p02, p05, p06)
 * - Project with only plannedStart, no plannedEnd (id: p04)
 * - Projects exceeding aging thresholds (id: p02, p04)
 * - Multi-week project (id: p09)
 * - Minimal data project (id: p06 — no address, no phone, no workers)
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

export const mockProjects: Project[] = [
  // === ANFRAGE (2) ===
  {
    id: 'p01',
    number: '2026-051',
    title: 'Fassadenanstrich Müller',
    status: 'anfrage',
    statusChangedAt: daysAgo(1),
    customer: { name: 'Familie Müller', phone: '+49 221 1234567', email: 'mueller@example.de' },
    address: { street: 'Hauptstr. 12', zip: '51465', city: 'Bergisch Gladbach' },
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
  },
  {
    id: 'p02',
    number: '2026-042',
    title: 'Treppenhaussanierung Schmidt',
    status: 'anfrage',
    statusChangedAt: daysAgo(10),
    customer: { name: 'Schmidt Hausverwaltung', phone: '+49 221 9876543', email: 'schmidt@example.de' },
    address: { street: 'Kölner Str. 45', zip: '50999', city: 'Köln' },
    createdAt: daysAgo(10),
    updatedAt: daysAgo(10),
    notes: 'Dringend — Mieter beschweren sich über Zustand.',
  },

  // === ANGEBOT (2) ===
  {
    id: 'p03',
    number: '2026-040',
    title: 'Büroräume streichen Weber',
    status: 'angebot',
    statusChangedAt: daysAgo(3),
    customer: { name: 'Weber & Partner GmbH', phone: '+49 221 5551234', email: 'weber@example.de' },
    address: { street: 'Industriestr. 8', zip: '51063', city: 'Köln' },
    plannedStart: daysFromNow(14),
    plannedEnd: daysFromNow(17),
    estimatedValue: 8500,
    createdAt: daysAgo(7),
    updatedAt: daysAgo(3),
  },
  {
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
  },

  // === BEAUFTRAGT (2) ===
  {
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
  },
  {
    id: 'p06',
    number: '2026-039',
    title: 'Malerarbeiten Neubau Yilmaz',
    status: 'beauftragt',
    statusChangedAt: daysAgo(2),
    customer: { name: 'Yilmaz Bau GmbH' },
    estimatedValue: 12000,
    createdAt: daysAgo(8),
    updatedAt: daysAgo(2),
  },

  // === GEPLANT (2) ===
  {
    id: 'p07',
    number: '2026-034',
    title: 'Wohnzimmer renovieren Klein',
    status: 'geplant',
    statusChangedAt: daysAgo(6),
    customer: { name: 'Familie Klein', phone: '+49 221 7778899', email: 'klein@example.de' },
    address: { street: 'Rosenstr. 15', zip: '50968', city: 'Köln' },
    plannedStart: daysFromNow(3),
    plannedEnd: daysFromNow(5),
    assignedWorkers: ['Thomas Braun', 'Markus Scholz'],
    estimatedValue: 5500,
    createdAt: daysAgo(18),
    updatedAt: daysAgo(6),
  },
  {
    id: 'p08',
    number: '2026-033',
    title: 'Außenanstrich Praxis Dr. Hoffmann',
    status: 'geplant',
    statusChangedAt: daysAgo(8),
    customer: { name: 'Dr. Hoffmann', phone: '+49 221 4443322', email: 'hoffmann@example.de' },
    address: { street: 'Bonner Str. 112', zip: '50677', city: 'Köln' },
    plannedStart: daysFromNow(7),
    plannedEnd: daysFromNow(10),
    assignedWorkers: ['Andreas Richter', 'Stefan Wolf'],
    estimatedValue: 9200,
    createdAt: daysAgo(22),
    updatedAt: daysAgo(8),
  },

  // === IN ARBEIT (3) ===
  {
    id: 'p09',
    number: '2026-028',
    title: 'Malerarbeiten Bürokomplex Weber',
    status: 'in_arbeit',
    statusChangedAt: daysAgo(5),
    customer: { name: 'Weber Immobilien AG', phone: '+49 221 6665544', email: 'immobilien@weber.de' },
    address: { street: 'Rheinuferstr. 20', zip: '50668', city: 'Köln' },
    plannedStart: daysAgo(5),
    plannedEnd: daysFromNow(9),
    assignedWorkers: ['Thomas Braun', 'Markus Scholz', 'Andreas Richter', 'Stefan Wolf'],
    estimatedValue: 24000,
    createdAt: daysAgo(35),
    updatedAt: daysAgo(1),
    notes: 'Großprojekt — 3 Etagen. Aufzug nur Mo/Mi/Fr verfügbar.',
  },
  {
    id: 'p10',
    number: '2026-030',
    title: 'Kinderzimmer streichen Pohl',
    status: 'in_arbeit',
    statusChangedAt: daysAgo(2),
    customer: { name: 'Familie Pohl', phone: '+49 2202 998877' },
    address: { street: 'Waldweg 22', zip: '51427', city: 'Bergisch Gladbach' },
    plannedStart: daysAgo(2),
    plannedEnd: today(),
    assignedWorkers: ['Stefan Wolf'],
    estimatedValue: 1800,
    createdAt: daysAgo(12),
    updatedAt: daysAgo(2),
  },
  {
    id: 'p11',
    number: '2026-029',
    title: 'Lackierung Geländer Schulze',
    status: 'in_arbeit',
    statusChangedAt: daysAgo(4),
    customer: { name: 'Schulze GbR', email: 'schulze@example.de' },
    address: { street: 'Berliner Str. 55', zip: '51063', city: 'Köln' },
    plannedStart: daysAgo(4),
    plannedEnd: daysAgo(1),
    assignedWorkers: ['Markus Scholz'],
    estimatedValue: 2200,
    createdAt: daysAgo(15),
    updatedAt: daysAgo(1),
    notes: 'Leicht über Zeitplan — Wetter hat Außenarbeiten verzögert.',
  },

  // === ABNAHME (1) ===
  {
    id: 'p12',
    number: '2026-025',
    title: 'Fassade Mehrfamilienhaus Braun',
    status: 'abnahme',
    statusChangedAt: daysAgo(3),
    customer: { name: 'Braun Immobilien', phone: '+49 221 2223344', email: 'braun@example.de' },
    address: { street: 'Aachener Str. 200', zip: '50931', city: 'Köln' },
    plannedStart: daysAgo(15),
    plannedEnd: daysAgo(4),
    assignedWorkers: ['Thomas Braun', 'Andreas Richter'],
    estimatedValue: 15500,
    createdAt: daysAgo(40),
    updatedAt: daysAgo(3),
  },

  // === RECHNUNG FÄLLIG (3) — critical accumulation ===
  {
    id: 'p13',
    number: '2026-022',
    title: 'Treppenhausrenovierung Meyer',
    status: 'rechnung_faellig',
    statusChangedAt: daysAgo(5),
    customer: { name: 'Meyer Hausverwaltung', phone: '+49 221 8889900', email: 'meyer@example.de' },
    address: { street: 'Zülpicher Str. 88', zip: '50937', city: 'Köln' },
    plannedStart: daysAgo(25),
    plannedEnd: daysAgo(18),
    assignedWorkers: ['Thomas Braun', 'Stefan Wolf'],
    estimatedValue: 7800,
    createdAt: daysAgo(45),
    updatedAt: daysAgo(5),
  },
  {
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
  },
  {
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
  },

  // === ABGERECHNET (2) ===
  {
    id: 'p16',
    number: '2026-015',
    title: 'Deckensanierung Schröder',
    status: 'abgerechnet',
    statusChangedAt: daysAgo(10),
    customer: { name: 'Familie Schröder', phone: '+49 221 1112233', email: 'schroeder@example.de' },
    address: { street: 'Luxemburger Str. 33', zip: '50674', city: 'Köln' },
    plannedStart: daysAgo(40),
    plannedEnd: daysAgo(35),
    estimatedValue: 6300,
    createdAt: daysAgo(55),
    updatedAt: daysAgo(10),
  },
  {
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
  },

  // === ERLEDIGT (2) ===
  {
    id: 'p18',
    number: '2026-008',
    title: 'Innenanstrich Gaststätte Krüger',
    status: 'erledigt',
    statusChangedAt: daysAgo(3),
    customer: { name: 'Krüger Gastronomie GmbH', phone: '+49 221 3334455', email: 'krueger@example.de' },
    address: { street: 'Severinstr. 199', zip: '50678', city: 'Köln' },
    plannedStart: daysAgo(30),
    plannedEnd: daysAgo(25),
    estimatedValue: 11200,
    createdAt: daysAgo(50),
    updatedAt: daysAgo(3),
  },
  {
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
  },
];
