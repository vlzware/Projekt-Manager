/**
 * Seed data loader for development and testing.
 *
 * Creates 10 customers, 19 projects across all 9 workflow states,
 * and 6 users (5 active + 1 inactive) with default password "changeme".
 *
 * Dates are relative to today — never hardcoded.
 */

import { sql } from 'drizzle-orm';
import { hashPassword } from './password.js';
import type { Database } from './db/connection.js';
import { users, customers, projects, projectWorkers } from './db/schema.js';

function daysFromNow(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(0, 0, 0, 0);
  return d;
}

const year = new Date().getFullYear();

/**
 * Seed the database with sample data.
 *
 * Behavior depends on the `force` option:
 * - `force: false` (default) — skip if users already exist, preserving
 *   manual changes across dev server restarts.
 * - `force: true` — wipe all data and re-seed. Used by tests for a
 *   guaranteed clean slate, and via SEED=force when seed data changes.
 */
export async function seed(db: Database, opts: { force?: boolean } = {}): Promise<void> {
  if (!opts.force) {
    const existing = await db.select({ id: users.id }).from(users).limit(1);
    if (existing.length > 0) {
      console.log('Database already seeded — skipping. Set SEED=force to wipe and re-seed.');
      return;
    }
  }

  // Clear existing data atomically
  await db.execute(
    sql`TRUNCATE TABLE project_workers, sessions, projects, customers, users CASCADE`,
  );

  // ---------------------------------------------------------------
  // Users (data-model.md §7.2)
  // ---------------------------------------------------------------
  const defaultHash = await hashPassword('changeme');

  const userRecords = [
    {
      username: 'inhaber',
      displayName: 'Thomas Berger',
      passwordHash: defaultHash,
      roles: ['owner'],
      email: 'berger@malerbetrieb-berger.de',
      active: true,
    },
    {
      username: 'buero',
      displayName: 'Maria Schmidt',
      passwordHash: defaultHash,
      roles: ['office'],
      email: 'schmidt@malerbetrieb-berger.de',
      active: true,
    },
    {
      username: 'arbeiter1',
      displayName: 'Jan Nowak',
      passwordHash: defaultHash,
      roles: ['worker'],
      email: null,
      active: true,
    },
    {
      username: 'arbeiter2',
      displayName: 'Lukas Fischer',
      passwordHash: defaultHash,
      roles: ['worker'],
      email: null,
      active: true,
    },
    {
      username: 'buchhalter',
      displayName: 'Petra Weiß',
      passwordHash: defaultHash,
      roles: ['bookkeeper'],
      email: 'weiss@steuerkanzlei-weiss.de',
      active: true,
    },
    {
      username: 'deaktiviert',
      displayName: 'Ehemaliger Mitarbeiter',
      passwordHash: defaultHash,
      roles: ['worker'],
      email: null,
      active: false,
    },
  ];

  const insertedUsers = await db
    .insert(users)
    .values(userRecords)
    .returning({ id: users.id, username: users.username });
  const userByUsername = new Map(insertedUsers.map((u) => [u.username, u.id]));

  // ---------------------------------------------------------------
  // Customers (data-model.md §7.3 — 10 customers, mix of full/minimal)
  // ---------------------------------------------------------------
  const customerRecords = [
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

  const insertedCustomers = await db
    .insert(customers)
    .values(customerRecords)
    .returning({ id: customers.id, name: customers.name });
  const customerByName = new Map(insertedCustomers.map((c) => [c.name, c.id]));

  // ---------------------------------------------------------------
  // Projects (data-model.md §7.1 — 19 projects across all 9 states)
  // ---------------------------------------------------------------
  const projectRecords = [
    // Anfrage (2) — recent, no dates planned
    {
      number: `${year}-001`,
      title: 'Fassadenanstrich Müller',
      status: 'anfrage',
      statusChangedAt: daysFromNow(-1),
      customerId: customerByName.get('Familie Müller')!,
      createdAt: daysFromNow(-1),
      updatedAt: daysFromNow(-1),
    },
    {
      number: `${year}-002`,
      title: 'Innenraumgestaltung Weber',
      status: 'anfrage',
      statusChangedAt: daysFromNow(-10),
      customerId: customerByName.get('Firma Weber GmbH')!,
      createdAt: daysFromNow(-10),
      updatedAt: daysFromNow(-10),
    },

    // Angebot (2) — one fresh, one stale
    {
      number: `${year}-003`,
      title: 'Treppenhaussanierung Schmidt',
      status: 'angebot',
      statusChangedAt: daysFromNow(-3),
      customerId: customerByName.get('Schmidt Hausverwaltung')!,
      estimatedValue: '8500.00',
      createdAt: daysFromNow(-5),
      updatedAt: daysFromNow(-3),
    },
    {
      number: `${year}-004`,
      title: 'Malerarbeiten Bürokomplex Weber',
      status: 'angebot',
      statusChangedAt: daysFromNow(-18),
      customerId: customerByName.get('Weber Immobilien')!,
      estimatedValue: '24000.00',
      createdAt: daysFromNow(-20),
      updatedAt: daysFromNow(-18),
    },

    // Beauftragt (2) — confirmed, no dates
    {
      number: `${year}-005`,
      title: 'Kellerdeckendämmung Becker',
      status: 'beauftragt',
      statusChangedAt: daysFromNow(-4),
      customerId: customerByName.get('Familie Becker')!,
      estimatedValue: '3200.00',
      createdAt: daysFromNow(-8),
      updatedAt: daysFromNow(-4),
    },
    {
      number: `${year}-006`,
      title: 'Fensteranstrich Schneider',
      status: 'beauftragt',
      statusChangedAt: daysFromNow(-2),
      customerId: customerByName.get('Herr Schneider')!,
      createdAt: daysFromNow(-6),
      updatedAt: daysFromNow(-2),
    },

    // Geplant (2) — dates assigned
    {
      number: `${year}-007`,
      title: 'Fassadensanierung Gemeindezentrum',
      status: 'geplant',
      statusChangedAt: daysFromNow(-7),
      customerId: customerByName.get('Evangelische Gemeinde Refrath')!,
      plannedStart: daysFromNow(5),
      plannedEnd: daysFromNow(12),
      estimatedValue: '18500.00',
      createdAt: daysFromNow(-14),
      updatedAt: daysFromNow(-7),
    },
    {
      number: `${year}-008`,
      title: 'Wohnungsrenovierung Klein',
      status: 'geplant',
      statusChangedAt: daysFromNow(-3),
      customerId: customerByName.get('Frau Klein')!,
      plannedStart: daysFromNow(8),
      plannedEnd: daysFromNow(10),
      estimatedValue: '4800.00',
      createdAt: daysFromNow(-10),
      updatedAt: daysFromNow(-3),
    },

    // In Arbeit (3) — currently on-site
    {
      number: `${year}-009`,
      title: 'Malerarbeiten Praxis Dr. Braun',
      status: 'in_arbeit',
      statusChangedAt: daysFromNow(-5),
      customerId: customerByName.get('Dr. Braun Zahnarztpraxis')!,
      plannedStart: daysFromNow(-5),
      plannedEnd: daysFromNow(2),
      estimatedValue: '12000.00',
      createdAt: daysFromNow(-18),
      updatedAt: daysFromNow(-5),
    },
    {
      number: `${year}-010`,
      title: 'Lackierung Treppengeländer Hoffmann',
      status: 'in_arbeit',
      statusChangedAt: daysFromNow(-3),
      customerId: customerByName.get('Familie Hoffmann')!,
      plannedStart: daysFromNow(-3),
      plannedEnd: daysFromNow(-1), // slightly past end — edge case
      estimatedValue: '2800.00',
      createdAt: daysFromNow(-12),
      updatedAt: daysFromNow(-3),
    },
    {
      number: `${year}-011`,
      title: 'Tapezierarbeiten Café Sonnenschein',
      status: 'in_arbeit',
      statusChangedAt: daysFromNow(-2),
      customerId: customerByName.get('Café Sonnenschein GbR')!,
      plannedStart: daysFromNow(-2),
      plannedEnd: daysFromNow(1),
      estimatedValue: '6500.00',
      createdAt: daysFromNow(-15),
      updatedAt: daysFromNow(-2),
    },

    // Abnahme (1) — waiting for customer walk-through
    {
      number: `${year}-012`,
      title: 'Außenanstrich Reihenhaus Wagner',
      status: 'abnahme',
      statusChangedAt: daysFromNow(-1),
      customerId: customerByName.get('Herr Wagner')!,
      plannedStart: daysFromNow(-10),
      plannedEnd: daysFromNow(-2),
      estimatedValue: '7200.00',
      createdAt: daysFromNow(-21),
      updatedAt: daysFromNow(-1),
    },

    // Rechnung fällig (3) — critical accumulation
    {
      number: `${year}-013`,
      title: 'Malerarbeiten Kita Sonnenkäfer',
      status: 'rechnung_faellig',
      statusChangedAt: daysFromNow(-2),
      customerId: customerByName.get('Stadt Bergisch Gladbach')!,
      plannedStart: daysFromNow(-20),
      plannedEnd: daysFromNow(-5),
      estimatedValue: '15000.00',
      createdAt: daysFromNow(-25),
      updatedAt: daysFromNow(-2),
    },
    {
      number: `${year}-014`,
      title: 'Bodenbeschichtung Autohaus Kramer',
      status: 'rechnung_faellig',
      statusChangedAt: daysFromNow(-5),
      customerId: customerByName.get('Autohaus Kramer GmbH')!,
      estimatedValue: '9800.00',
      createdAt: daysFromNow(-28),
      updatedAt: daysFromNow(-5),
    },
    {
      number: `${year}-015`,
      title: 'Anstrich Gartenlaube Peters',
      status: 'rechnung_faellig',
      statusChangedAt: daysFromNow(-8),
      customerId: customerByName.get('Herr Peters')!,
      estimatedValue: '1200.00',
      createdAt: daysFromNow(-22),
      updatedAt: daysFromNow(-8),
    },

    // Abgerechnet (2) — invoice sent, waiting for payment
    {
      number: `${year}-016`,
      title: 'Fassadenanstrich Schule am Park',
      status: 'abgerechnet',
      statusChangedAt: daysFromNow(-3),
      customerId: customerByName.get('Rheinisch-Bergischer Kreis')!,
      plannedStart: daysFromNow(-28),
      plannedEnd: daysFromNow(-15),
      estimatedValue: '32000.00',
      createdAt: daysFromNow(-30),
      updatedAt: daysFromNow(-3),
    },
    {
      number: `${year}-017`,
      title: 'Lackierarbeiten Türen Metzgerei Frank',
      status: 'abgerechnet',
      statusChangedAt: daysFromNow(-6),
      customerId: customerByName.get('Metzgerei Frank')!,
      estimatedValue: '3600.00',
      createdAt: daysFromNow(-24),
      updatedAt: daysFromNow(-6),
    },

    // Erledigt (2) — completed and paid
    {
      number: `${year}-018`,
      title: 'Malerarbeiten Neubau Richter',
      status: 'erledigt',
      statusChangedAt: daysFromNow(-5),
      customerId: customerByName.get('Familie Richter')!,
      plannedStart: daysFromNow(-25),
      plannedEnd: daysFromNow(-12),
      estimatedValue: '21000.00',
      createdAt: daysFromNow(-28),
      updatedAt: daysFromNow(-5),
    },
    {
      number: `${year}-019`,
      title: 'Wandgestaltung Kanzlei Dr. Meier',
      status: 'erledigt',
      statusChangedAt: daysFromNow(-10),
      customerId: customerByName.get('Kanzlei Dr. Meier')!,
      estimatedValue: '5400.00',
      createdAt: daysFromNow(-26),
      updatedAt: daysFromNow(-10),
    },
  ];

  const insertedProjects = await db
    .insert(projects)
    .values(projectRecords)
    .returning({ id: projects.id, number: projects.number });
  const projectByNumber = new Map(insertedProjects.map((p) => [p.number, p.id]));

  // ---------------------------------------------------------------
  // Project–Worker assignments
  // ---------------------------------------------------------------
  const arbeiter1 = userByUsername.get('arbeiter1')!;
  const arbeiter2 = userByUsername.get('arbeiter2')!;

  const assignments: { projectNumber: string; userId: string }[] = [
    // Geplant
    { projectNumber: `${year}-007`, userId: arbeiter1 },
    { projectNumber: `${year}-007`, userId: arbeiter2 },
    { projectNumber: `${year}-008`, userId: arbeiter1 },
    // In Arbeit
    { projectNumber: `${year}-009`, userId: arbeiter1 },
    { projectNumber: `${year}-009`, userId: arbeiter2 },
    { projectNumber: `${year}-010`, userId: arbeiter2 },
    { projectNumber: `${year}-011`, userId: arbeiter1 },
  ];

  await db.insert(projectWorkers).values(
    assignments.map((a) => ({
      projectId: projectByNumber.get(a.projectNumber)!,
      userId: a.userId,
    })),
  );

  console.warn(
    '⚠  Seed-Daten geladen. Alle Benutzer haben das Standardpasswort "changeme". ' +
      'Passwörter müssen vor Produktiveinsatz geändert werden.',
  );
}
