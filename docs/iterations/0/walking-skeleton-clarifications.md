# Walking Skeleton — Clarification State

Status: Updated 2026-04-02 (post team discussion + owner corrections)

## Scope Distinction

The "Done when" section in the Kickoff defines the **final product**, not the walking skeleton.
The walking skeleton (Iteration 1) is specifically:

> Demonstration of consolidated preview of the state of projects — a calendar and a Kanban view
> (including for example "you have X completed projects without invoice"), using mock data.

This must include basic interactivity (not just a static picture) to be presentable.
The presentation targets the **owner** primarily — to see what the concept means. Other stakeholders, real data, complex menus, additional views — all later iterations.

## Core UX Principle

**The main point of the system is to make inaction visible.** Every action waiting on the user must SCREAM. The entire motivation (see Kickoff Background) is that things fall through the cracks: missed invoices, forgotten follow-ups, no overview. The system exists to prevent this by making pending actions impossible to ignore.

## Decided

### Audience
Both developer validation and stakeholder demonstration. Must look credible. Aimed at the owner/office manager.

### Platform
Web application, browser-based. No native apps, no installed software. Derived from Kickoff — non-technical users, Windows PCs + Android smartphones. A native app with extended features may follow in later iterations.

### Project definition (skeleton)
A project is a single commissioned job for a single customer at a single location. "Bathroom renovation for Frau Müller, Hauptstraße 5" is a project. "All work for Frau Müller" is not (that's a customer). "Installing the toilet" is not (that's a task within a project). An Angebot IS a project from the moment it's created — not a separate pre-project entity.

### Project lifecycle — 6 states with action/waiting alternation

The states follow the Kickoff workflow and alternate between "buffer" (waiting) and "action needed":

| State | Type | Meaning |
|-------|------|---------|
| Anfrage | **ACTION** | Customer inquiry received — create an offer! |
| Angebot | buffer | Offer sent, waiting for customer response |
| Beauftragt | **ACTION** | Customer confirmed — schedule & execute! |
| In Arbeit | buffer | Work in progress |
| Bestätigt | **ACTION** | Customer accepted work (Abnahme) — send the invoice! |
| Abgerechnet | buffer | Invoice sent, waiting for payment |
| Abgeschlossen | done | Complete |

**Action columns** (Anfrage, Beauftragt, Bestätigt) get aggressive visual emphasis on the Kanban board. These are the states where the company's inaction causes the problems described in the Kickoff. Example: "A customer has been waiting for an offer for a whole month now."

**No transition validation** in the skeleton — any state can transition to any state via drag. Transition rules are later-iteration business logic.

**Deferred states**: pausiert (cross-cutting flag, not a workflow state), storniert/abgelehnt (terminal states), archiviert.

### Kanban — 7 columns matching the 7 states

| Column | Visual treatment |
|--------|-----------------|
| Anfrage | **Emphasized — requires company action** |
| Angebot | Normal (buffer) |
| Beauftragt | **Emphasized — requires company action** |
| In Arbeit | Normal (buffer) |
| Bestätigt | **Emphasized — requires company action** |
| Abgerechnet | Normal (buffer) |
| Abgeschlossen | Subdued (done) |

- Drag-and-drop between columns changes project state.
- State changes also possible via dropdown on the project card.
- Cards show: project name (customer + location), date range, state.
- Sorting within columns: by date (soonest/oldest first as contextually appropriate).

### Calendar

- **Default view: week** — how Handwerker companies think ("what's this week, what's next week?").
- **Zoomable** — user can zoom out to month or further for overview.
- Projects displayed as **date-range bars**.
- **Today is visually emphasized** with very noticeable notification badges about open issues requiring attention. Aggressive, social-media-style notifications — the more annoying, the better.
- **Clicking on today opens the Kanban board** — this is the daily workflow entry point: "What needs my attention right now?"
- Navigation: prev/next arrows, today button.

### Calendar ↔ Kanban link
The calendar and Kanban are not independent views — they are linked. The calendar provides the temporal overview; clicking today transitions to the Kanban for the operational "what needs action now" view. Both show the same underlying project data.

### Billing state — simple enum on the project
Two values for the skeleton: `offen` (not invoiced) | `abgerechnet` (invoiced). Shown as a visual indicator/badge on Kanban cards. No transition validation. Extensible to more values in later iterations.

Alerts are computed from action states with pending work — e.g., "X Anfragen ohne Angebot", "X bestätigte Projekte ohne Rechnung".

### Branding and theming
The skeleton needs a set of defining colors and a logo. For the open-source project, these will be invented. In a real installation, the customer provides their own colors and logo for consistent company branding. This is ADR-0001 (configurable customer specifics) in action — theming is configurable. **ADR candidate: theming/branding as configurable customer specific.**

### UI language
German for all user-facing elements. Non-negotiable from day one.

### Mock data
A couple dozen projects spanning all 7 states. Reflects a small company. Domain-representative data, not modeled after a specific company.

### Interactivity (walking skeleton)
- Set or change project from/to dates (calendar interaction).
- Move projects between Kanban states (drag-and-drop).
- Change state and billing via dropdowns on the project card.
- Click a project to open a "project card" with basic data (modal/overlay).
- No user management, no login, no role-based access.

## Minimum entities (skeleton)

| Entity | Purpose | Key fields |
|--------|---------|------------|
| Customer (Kunde) | Who the project is for | id, name, address, phone, email (all optional except name) |
| Project (Projekt) | Central entity | id, customer_id (FK), title, description, planned_start, planned_end, execution_state (7-value enum), billing_state (2-value enum), created_at, updated_at |

Deliberately excluded from skeleton: users, roles, file attachments, notifications, services/materials, task sub-entities, invoice entities, project notes.

## Still open (to be resolved before spec)

### Project card fields
Exact enumerated field list with types. Proposals ranged from 7-10 fields. Must be a closed list — "7-8 fields" is not a spec. Suggested minimum: Projektname, Kunde, Adresse, Status, Rechnungsstatus, Startdatum, Enddatum, Beschreibung.

### Responsive behavior
One breakpoint (e.g., 768px) with defined layout changes. Desktop-first for the skeleton; basic mobile responsiveness (does not break, all elements tappable). Mobile-specific patterns (accordion Kanban, bottom sheets) deferred.

### Calendar detail questions
- Bar content: what's visible on a date-range bar without clicking?
- Overlap handling: stacking behavior when multiple projects share dates.
- Multi-month bars: clipped at boundaries or continuous?
- Projects without dates: excluded from calendar (Kanban only)?

### Notification / alert presentation
- Exact content of today's notification badges on the calendar.
- Exact content of the Kanban summary strip (if separate from calendar alerts).
- Zero-count behavior.
- German grammar handling (singular/plural).

### Visual design
- Color mapping: what dimension does color encode (state? urgency? project type?)?
- The "screaming" visual treatment for action columns — how aggressive exactly?
- Branding colors and logo for the open-source version.

### Interaction details
- Project card: opened by click on Kanban card AND calendar bar? Closed by X / click outside / Escape?
- Calendar date changes: drag bar edges? Click to open date picker?
- Empty column/calendar placeholder behavior.
