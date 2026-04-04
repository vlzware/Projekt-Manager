# Product Specification

**Source documents:** [Kickoff](project/kickoff.md), [Plan](project/plan.md)

---

## 1. Goal

Deliver a front-end-only prototype that demonstrates a consolidated preview of the state of all projects across the main company workflow. The prototype uses mock data and provides two complementary views — a **Kanban board** and a **Calendar** — with basic interactivity. Its purpose is to validate the information architecture and interaction model before backend work begins.

The walking skeleton must answer one question:

> "Can this system show the company, in one place, what projects exist, what state they are in, what is scheduled when, and where action is overdue?"

---

## 2. Scope

### 2.1 In Scope

- Kanban board with one column per workflow state
- Calendar view (month) showing scheduled projects
- Project detail panel accessible from both views
- State transitions (forward/backward by one step)
- Date changes (planned start/end)
- Summary area with aggregate indicators
- Mock data (15–20 projects across all states)
- German UI, English code
- All company-specific values configurable

### 2.2 Out of Scope

- Backend, database, API
- User authentication and roles
- Project creation or deletion
- Field editing beyond status and dates
- File uploads
- Notifications (email, WhatsApp)
- Worker view, bookkeeper view
- Data persistence beyond browser session
- Hosting / deployment
- Mobile optimization
- Print or export
- i18n framework (German only, hardcoded strings are fine)

---

## 3. Workflow States

The Kanban board reflects the full company workflow with 9 states. Each state has a type that determines its visual treatment.

| # | State | Type | Description |
|---|---|---|---|
| 1 | **Anfrage** | Action | Inquiry received — company must write an offer |
| 2 | **Angebot** | Buffer | Offer sent — waiting for customer confirmation |
| 3 | **Beauftragt** | Action | Customer confirmed — company must plan and schedule |
| 4 | **Geplant** | Buffer | Planned — waiting for its turn on the calendar |
| 5 | **In Arbeit** | Active | Being executed (incl. Aufmaß, photos, etc.) |
| 6 | **Abnahme** | Buffer | Execution complete — waiting for customer acceptance |
| 7 | **Rechnung fällig** | Action | Customer accepted — company must write the invoice |
| 8 | **Abgerechnet** | Buffer | Invoice sent — waiting for payment |
| 9 | **Erledigt** | Done | Payment received — project closed |

Three action states, four buffer states, one active, one terminal. The Kanban board makes action states naturally visible — items accumulating in an action column signal that work is falling behind.

---

## 4. Reasonable Assumptions

All assumptions are candidates for later configuration, marked **[C]**.

### 4.1 Company Profile

| Attribute | Assumed Value |
|---|---|
| Trade | Maler- und Lackiererbetrieb (painter / coating contractor) **[C]** |
| Employees | Owner, 1 office manager, 4–6 workers, 1 external bookkeeper **[C]** |
| Concurrent active projects | 10–30 **[C]** |
| Typical project duration | 1–10 working days **[C]** |
| Region | Single metropolitan area (~50 km radius) **[C]** |

### 4.2 Users (Walking Skeleton)

Only the **Owner / Office Manager** perspective is implemented. They see everything and can change dates and states. Other roles (workers, bookkeeper) are deferred.

### 4.3 Scheduling

Each project has at most one planned date range (start/end) representing the main execution slot. Detailed crew or resource planning is deferred.

### 4.4 Data Origin

All data is mock data, loaded from a static TypeScript file into in-memory state. Changes persist only for the browser session.

---

## 5. Data Model

### 5.1 Project Entity

```typescript
type WorkflowState =
  | 'anfrage'
  | 'angebot'
  | 'beauftragt'
  | 'geplant'
  | 'in_arbeit'
  | 'abnahme'
  | 'rechnung_faellig'
  | 'abgerechnet'
  | 'erledigt';

interface Project {
  id: string;                  // UUID
  number: string;              // "2026-042" — year + sequential [C]
  title: string;               // "Fassadenanstrich Müller"
  status: WorkflowState;
  statusChangedAt: string;     // ISO 8601 — for aging calculations

  customer: {
    name: string;              // "Familie Müller"
    phone?: string;            // "+49 221 1234567"
    email?: string;            // "mueller@example.de"
  };

  address?: {
    street: string;            // "Hauptstr. 12"
    zip: string;               // "51465"
    city: string;              // "Bergisch Gladbach"
  };

  plannedStart?: string;       // ISO 8601 date
  plannedEnd?: string;         // ISO 8601 date

  assignedWorkers?: string[];  // display names — placeholder; future iterations will use Worker entity IDs
  estimatedValue?: number;     // EUR net
  notes?: string;

  createdAt: string;           // ISO 8601
  updatedAt: string;           // ISO 8601
}
```

Design notes:
- `statusChangedAt` is separate from `updatedAt` — editing notes must not reset aging calculations.
- Customer and address are nested objects for clarity and future extensibility. **Known debt**: `customer` is inline (denormalized). Future iterations will extract to a `Customer` entity for cross-project lookup, deduplication, and LLM email extraction.
- `assignedWorkers` is `string[]` of display names. **Known debt**: will be replaced by `Worker` entity references for role-based views and worker management.
- No `priority` field — priority is implicit in state aging and column accumulation.
- No stored boolean flags for warnings — these are derived from state and timestamps at render time.
- Internal keys use English; German labels are applied at the UI layer.

### 5.2 State Metadata

```typescript
type StateType = 'action' | 'buffer' | 'active' | 'done';

interface StateConfig {
  key: WorkflowState;
  label: string;               // German display label
  type: StateType;
  order: number;               // position in workflow sequence (1-9)
  color: string;               // hex color
  agingThresholdDays?: number; // days before aging indicator appears [C]
  agingBoldDays?: number;      // days before date display turns bold [C]
}
```

This configuration drives Kanban column rendering, color coding, and aging indicators from a single source.

**Aging field mapping by state type:**

| State type | `agingBoldDays` | `agingThresholdDays` | Visual effect |
|---|---|---|---|
| Action | Used | Ignored | Entry date turns **bold** after threshold |
| Buffer | Used (same as threshold) | Used | Entry date turns **bold** + `"seit X Tagen"` text appears |
| Active | Ignored | Ignored | No aging behavior |
| Done | Ignored | Ignored | No aging behavior |

---

## 6. UI Specification

### 6.1 Layout

```
┌──────────────────────────────────────────────────────────┐
│  Header: App Name  |  [Kanban] [Kalender]  |  Summary   │
├──────────────────────────────────────────────────────────┤
│                                                          │
│                     Active View                          │
│               (Kanban or Calendar)                       │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  Footer: "Projekt-Manager · Walking Skeleton · Mockdaten"│
└──────────────────────────────────────────────────────────┘
```

- **Header**: app name, view toggle (Kanban / Kalender), summary indicators.
- **Default view**: Kanban (the primary overview tool). Toggling switches between views.
- **Footer**: marks this as a prototype with mock data.
- **Responsive target**: 1920×1080 desktop monitor and tablet (1024×768 minimum). Mobile is out of scope.

### 6.2 Kanban View

#### 6.2.1 Columns

The board has **9 columns**, one per workflow state. Each column header shows the German label and the card count.

Action columns are visually distinct from buffer columns (e.g., warm-tinted background for action, neutral for buffer). This distinction makes the board structure itself communicate which columns demand attention.

With 9 columns, horizontal scrolling may be needed on narrower screens. At 1920px, each column gets ~200px — tight but workable.

#### 6.2.2 Project Card

```
┌─────────────────────────────┐
│ [●] 2026-042                │
│ Fassadenanstrich Müller     │
│ Familie Müller              │
│ 14.04. – 18.04.2026        │
│                        [→]  │
└─────────────────────────────┘
```

- **[●]** Color dot matching the state color.
- **Project number** and **title**.
- **Customer name**.
- **Date range** if available; `"Kein Termin"` otherwise.
- **[→] button** advances to the next workflow state. Confirmation dialog: `"Status ändern: Geplant → In Arbeit?"` with OK / Abbrechen. Hidden for `Erledigt` cards.

Cards within a column are sorted by `statusChangedAt` ascending (longest-waiting on top).

#### 6.2.3 Entry Date and Aging

Every card shows its `statusChangedAt` as a small date label (e.g., `"seit 15.03.2026"`). This makes the age of every card visible regardless of state type.

**Action states**: after a configurable threshold (`agingBoldDays`), the entry date turns **bold** — a subtle but clear flag that this item has been waiting too long. Default thresholds **[C]**:
- Anfrage: 3 days
- Beauftragt: 5 days
- Rechnung fällig: 3 days

**Buffer states**: after a configurable threshold (`agingThresholdDays`), the entry date turns bold and the card additionally shows `"seit X Tagen"` as a text indicator. Default thresholds **[C]**:
- Angebot: 14 days
- Geplant: 21 days
- Abnahme: 7 days
- Abgerechnet: 30 days

#### 6.2.4 Interactivity

- **Click on a card** → opens the Project Detail Panel (6.4).
- **[→] button** → state transition with confirmation dialog.
- **Drag between adjacent columns** → optional for the walking skeleton. If implemented, only adjacent-column drops are accepted (no skipping states).

### 6.3 Calendar View

#### 6.3.1 Display

- **Default**: month view of the current month. Navigation to previous/next months.
- **Week view toggle**: available but secondary.
- Projects with `plannedStart` and `plannedEnd` render as **horizontal bars** spanning those dates.
- Projects with only `plannedStart` (no `plannedEnd`) render as a **single-day block** on the start date.
- Bar color encodes the workflow state (see 6.6).
- Projects without planned dates do **not** appear. A counter below the calendar reads: `"X Projekte ohne Termin"` — clicking it switches to Kanban view.

#### 6.3.2 Interactivity

- **Click on a project bar** → opens the Project Detail Panel (6.4).
- **Date editing** is done via the Project Detail Panel (6.4). Calendar drag-to-resize is deferred (see open question 2).

### 6.4 Project Detail Panel

A **slide-in panel** from the right side (not a modal — the user retains context of the view behind it). Width: ~400px on desktop.

Contents:
- Project number, title (large)
- Current status with colored badge + German label
- **"Nächster Schritt" button** → forward transition (same as [→]). Hidden for `Erledigt`.
- **"Vorheriger Schritt" button** → backward transition, styled less prominently. Hidden for `Anfrage` (no previous state) and `Erledigt` (terminal).
- Customer: name, phone (`tel:` link), email (`mailto:` link)
- Address: full address with Google Maps link (`https://www.google.com/maps/search/?api=1&query={street}+{zip}+{city}`)
- **Dates: planned start/end** — editable via date picker inputs. Changes update `plannedStart`/`plannedEnd` and are reflected in both views immediately.
- Assigned workers (list of names)
- Estimated value, formatted as `8.500,00 €` (German locale)
- Notes (read-only)
- Timestamps: created, last updated, status changed

Editing beyond state transitions and dates is **not** in scope.

### 6.5 Summary Area

Displayed in the header. Shows aggregate counts computed from current project data:

- Count of projects in each action state: e.g., `"3× Rechnung fällig"`, `"2× Anfrage"`
- Count of projects in buffer states exceeding aging thresholds: e.g., `"1 Angebot seit >14 Tagen"`

Clicking an indicator filters the current view to show only the affected projects. Non-matching cards are hidden (not dimmed). A `"Filter aufheben"` (clear filter) button appears in the summary area while a filter is active. Switching views clears the filter.

Summary values update immediately after any state change.

### 6.6 Color Coding

Each state has an assigned color. Action states use warm tones, buffer states use cool tones.

| State | Type | Suggested Color | Hex |
|---|---|---|---|
| Anfrage | Action | Orange | `#F97316` |
| Angebot | Buffer | Light blue | `#93C5FD` |
| Beauftragt | Action | Amber | `#F59E0B` |
| Geplant | Buffer | Blue | `#3B82F6` |
| In Arbeit | Active | Green | `#22C55E` |
| Abnahme | Buffer | Teal | `#14B8A6` |
| Rechnung fällig | Action | Red | `#EF4444` |
| Abgerechnet | Buffer | Indigo | `#6366F1` |
| Erledigt | Done | Gray | `#9CA3AF` |

Colors are configurable via the state configuration (5.2). The warm/cool grouping is the design principle; exact values may be adjusted during implementation.

---

## 7. Behavioral Rules

### 7.1 State Transitions

- **Forward**: to the next state in the sequence. Allowed from any state except `erledigt`.
- **Backward**: to the immediately preceding state. Allowed from any state except `anfrage` (no previous) and `erledigt` (terminal).
- **No skipping**: direct jumps across multiple states are not allowed.
- **Terminal**: `erledigt` is a terminal state — no forward or backward transitions. Both transition buttons are hidden in the UI.
- **Cancellation**: not in scope for the walking skeleton.

Every transition shows a confirmation dialog in German before executing: `"Status ändern: {current} → {target}?"` with OK / Abbrechen.

### 7.2 Inaction Visibility

Visibility is provided by three mechanisms:

**Board structure** (primary): action columns with accumulated cards are immediately visible. The column IS the signal.

**Entry date on every card**: every card shows its `statusChangedAt` date. This makes age visible at a glance regardless of state type. After a configurable threshold, the date turns **bold** — a clear flag without decorative excess.

**Buffer aging text** (for buffer states only): cards exceeding their `agingThresholdDays` additionally show `"seit X Tagen"` as a text indicator, since buffer-column accumulation is normal and doesn't inherently signal a problem.

Thresholds are defined in `StateConfig` (section 5.2) and listed in section 6.2.3.

### 7.3 Date Handling

- All dates displayed in German format: `DD.MM.YYYY` or `DD.MM.` when year is obvious.
- Week starts on **Monday** (ISO 8601 / German convention).
- No time zones — all dates are local calendar dates.

---

## 8. Non-Functional Requirements

### 8.1 Usability

- Understandable by non-technical users in a demo context.
- Main actions discoverable without training.
- State type distinction (action/buffer) visually obvious at a glance.

### 8.2 Performance

- Initial page load under 3 seconds (local dev server).
- User actions reflected within 200ms.
- Given 15–20 mock projects, performance is not a concern — but the architecture must not preclude scaling to 50+ projects later.

### 8.3 Maintainability

- Domain types separated from UI components.
- Warning/aging logic separated from presentation.
- Mock data separated from business rules.
- State configuration (labels, colors, thresholds) centralized, not scattered.

### 8.4 Accessibility

Not full compliance, but minimally:
- Sufficient color contrast for state indicators.
- Warning information not conveyed by color alone (text labels accompany colors).
- Keyboard navigation for primary interactions where practical.

### 8.5 Robustness

The UI must tolerate incomplete project data without crashing:
- Missing dates (project appears in Kanban but not calendar).
- Missing address, phone, email (detail panel shows available fields only).
- Missing notes (field simply absent).

---

## 9. Architectural Constraints

### 9.1 Mandatory Constraints

- Language: **TypeScript** (type safety for the data model is non-negotiable)
- Testing: unit tests + component tests + at least one E2E smoke test
- Stack decisions are recorded in [ADR-0002](docs/adr/0002-tech-stack-typescript-react-vite-zustand.md)

### 9.2 Responsibility Boundaries

The system is organized into four responsibility layers:

| Layer | Responsibility |
|---|---|
| **Config** | State definitions, thresholds, colors, company assumptions. Imported by other layers, imports nothing. |
| **Domain** | Pure functions: transition rules, aging calculation, types. Never imports from state or UI. |
| **State** | Data access layer: holds current state, exposes all mutations. UI components never modify state directly. |
| **UI** | Presentation only. May import from domain for types. Dispatches actions to the state layer. |

Mock data is loaded once at initialization into the state layer.

**Dependency direction** (no reverse imports):

```
config  ←  domain  ←  state  ←  ui
```

### 9.3 State Layer Behavioral Contract

The state layer must support at minimum:

**State:** the full project list, an optional active filter (by workflow state), and the active view (Kanban or calendar).

**Mutations:**
- Transition a project forward or backward by one state
- Update a project's planned start/end dates
- Set or clear a filter by workflow state
- Switch between views (clears active filter)

**Queries:**
- Projects grouped by workflow state
- Summary: count of projects per action state, count of aged buffer items per state with threshold, count of projects without planned dates

All mutations go through the state layer — UI components never modify project data directly. This ensures the state layer can be swapped to a real backend without touching UI components.

**Known debt**: state actions currently mutate silently. Future iterations will need middleware or an event hook for audit trail and notification triggers. For the walking skeleton, direct mutation is acceptable.

### 9.4 Extensibility Checklist

The system must not close doors that later iterations need open:

| Door | How it stays open | Closed if... |
|---|---|---|
| Adding/removing workflow states | States driven by configuration array, not hardcoded logic | Column count or state names are hardcoded in components |
| Adding a backend | All mutations go through state layer | UI components read/write state directly |
| Adding new views (worker, bookkeeper, dashboard) | Views consume the shared state layer independently | Kanban and Calendar are coupled to each other |
| Adding fields to Project | Interface with optional fields; UI tolerates missing data | Components crash on undefined fields |
| Adding file uploads / attachments | Project model accepts optional attachments | Data layer assumes all project data fits in a single flat object |
| Adding authentication / roles | Views don't assume a single user; state layer can be extended with auth context | User identity is baked into component logic |
| Adding notifications | State transitions go through a central layer that can be extended with middleware | Transitions are handled inline in UI event handlers |
| Multi-language (low priority) | UI strings are grouped in identifiable locations, not scattered | Strings are inline literals spread across dozens of files |

This is not a feature list — it is a checklist of architectural decisions that must not be made in a way that forecloses them.

---

## 10. Mock Data Specification

### 10.1 Dataset Size

**15–20 projects**, distributed to create a realistic snapshot with visible action-state accumulation:

| State | Count | Notes |
|---|---|---|
| Anfrage | 2 | Recent, no dates planned. One received yesterday, one 10 days ago (stale). |
| Angebot | 2 | One sent 3 days ago, one sent 18 days ago (exceeds aging threshold). |
| Beauftragt | 2 | Confirmed, no dates yet. |
| Geplant | 2 | Dates assigned, workers assigned. |
| In Arbeit | 3 | Currently on-site. One slightly past `plannedEnd`. |
| Abnahme | 1 | Waiting for customer walk-through. |
| Rechnung fällig | 3 | **Critical accumulation** — demonstrates the core value. |
| Abgerechnet | 2 | Invoice sent, waiting for payment. |
| Erledigt | 2 | Recently completed and paid. |

### 10.2 Edge Cases

The dataset must include:
- At least 1 project with no planned dates (appears in Kanban, not calendar).
- At least 1 project with only `plannedStart`, no `plannedEnd`.
- At least 2 projects with `statusChangedAt` exceeding aging thresholds.
- At least 1 multi-week project (bar spans multiple weeks in calendar).
- At least 1 project with minimal data (no address, no phone, no workers).

### 10.3 Date Range

Mock data covers roughly the past 4 weeks to the coming 4 weeks, providing meaningful content for both views.

### 10.4 Realism

Project titles, customer names, and addresses should be domain-representative for a German Handwerker company (see assumption 4.1). Example: `"Fassadenanstrich Müller"`, `"Treppenhaussanierung Schmidt"`, `"Malerarbeiten Bürokomplex Weber"`.

---

## 11. Acceptance Criteria

The walking skeleton is accepted when all of the following are true.

### 11.1 Core

- AC-1: The application starts with `npm run dev` and requires no backend.
- AC-2: Kanban view renders 9 columns with all mock projects in their correct states.
- AC-3: Calendar view renders projects with planned dates as colored bars on a month grid.
- AC-4: Clicking a project in either view opens the detail panel with all available fields.
- AC-5: The [→] button transitions a project to the next state, with a German confirmation dialog. The card moves to the correct column.
- AC-6: Backward transition via the detail panel moves a project to the previous state.
- AC-7: Changing a date in the detail panel updates `plannedStart`/`plannedEnd` and is reflected in both views.
- AC-8: Summary area shows counts for action states and aged buffer items.
- AC-9: Clicking a summary indicator filters the view to affected projects.
- AC-10: "X Projekte ohne Termin" counter appears below the calendar.

### 11.2 Visual

- AC-11: Action columns are visually distinct from buffer columns.
- AC-12: Each state has a consistent color across Kanban dots, calendar bars, and detail badge.
- AC-13: Aged buffer items show a `"seit X Tagen"` indicator.
- AC-14: Cards display project number, title, customer, dates (or "Kein Termin").
- AC-15: Every card shows its `statusChangedAt` date. The date turns bold when the configured aging threshold is exceeded.

### 11.3 Behavioral

- AC-16: State transitions only allow forward +1 or backward -1. No skipping.
- AC-17: `Erledigt` is terminal — both transition buttons are hidden.
- AC-18: `Anfrage` hides the backward transition button.
- AC-19: All dates display in German format (DD.MM.YYYY). Calendar week starts Monday.
- AC-20: UI does not crash on projects with missing optional fields.

### 11.4 Engineering

- AC-21: Code is structured into the modules defined in 9.2.
- AC-22: All data mutations go through the state layer, not directly from UI components.
- AC-23: State configuration (labels, colors, thresholds) is centralized in `config/`.
- AC-24: Dependency direction (9.2) is enforced — no reverse imports.
- AC-25: Linting and formatting pass.
- AC-26: Tests defined in section 12 pass.

### 11.5 Configurability

- AC-27: App name (header) and footer text are driven by a branding config, not hardcoded in components. Changing the config changes all instances.

### 11.6 Responsive

- AC-28: At viewport widths below 1780px, tier-3 columns (Angebot, Abgerechnet, Erledigt) collapse to slim indicators showing the column header and card count. Cards are hidden.
- AC-29: At viewport widths below 1350px, tier-2 columns (Geplant, In Arbeit, Abnahme) also collapse.
- AC-30: At viewport widths below 940px, tier-1 columns (Anfrage, Beauftragt, Rechnung fällig) also collapse. Action columns are always the last to collapse.
- AC-31: Clicking a collapsed column expands it. Clicking the column header again collapses it.

---

## 12. Test Specification

### 12.1 Unit Tests

- UT-1: Aging calculation — returns correct `"seit X Tagen"` for a buffer project exceeding threshold.
- UT-2: Aging calculation — returns nothing for a project below threshold.
- UT-3: Aging bold — returns true for an action-state project exceeding `agingBoldDays`.
- UT-4: State transition — `getNextState('geplant')` returns `'in_arbeit'`.
- UT-5: State transition — `getNextState('erledigt')` returns `null`.
- UT-6: State transition — `getPreviousState('anfrage')` returns `null`.
- UT-7: State transition — `getPreviousState('erledigt')` returns `null`.
- UT-8: Summary computation — correctly counts projects per action state.
- UT-9: Summary computation — correctly counts aged buffer items.

### 12.2 Component Tests

- CT-1: Kanban board renders 9 columns with correct German labels.
- CT-2: Kanban board distributes mock projects into correct columns.
- CT-3: Project card displays number, title, customer, date range, entry date.
- CT-4: Project card shows "Kein Termin" when dates are missing.
- CT-5: Project card shows bold entry date when aging threshold exceeded.
- CT-6: Clicking a card opens the detail panel.
- CT-7: [→] button triggers state change and moves card to next column.
- CT-8: [→] button is hidden on `Erledigt` cards.
- CT-9: Backward transition via detail panel moves card to previous column.
- CT-10: Backward button is hidden for `Anfrage` and `Erledigt`.
- CT-11: Calendar renders projects with dates as colored bars.
- CT-12: Calendar renders single-date project as single-day block.
- CT-13: Summary area updates after a state change.
- CT-14: Clicking a summary indicator filters the Kanban to matching projects.
- CT-15: "Filter aufheben" button clears the filter.
- CT-16: "X Projekte ohne Termin" counter appears below calendar.
- CT-17: Changing dates in detail panel updates calendar bar position.

### 12.3 E2E Smoke Test

One scenario covering the full interaction path:

1. App loads — Kanban view is displayed with 9 columns.
2. Summary area shows `"3× Rechnung fällig"`.
3. User clicks a summary indicator — view filters to matching projects.
4. User clicks "Filter aufheben" — full view restored.
5. User clicks a card in `Geplant` — detail panel opens.
6. User clicks "Nächster Schritt" — confirmation dialog appears.
7. User confirms — card moves to `In Arbeit`.
8. User clicks "Vorheriger Schritt" on the same card — card moves back to `Geplant`.
9. User changes planned end date via date picker in detail panel.
10. User switches to calendar view — the project bar reflects the new date.
11. User clicks "X Projekte ohne Termin" — switches to filtered Kanban.
12. Summary area reflects current state counts throughout.

---

## 13. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| 9 Kanban columns too tight on screen | Usability | Horizontal scroll; or evaluate column grouping with sub-columns |
| Custom month grid more work than expected | Delays delivery | Evaluate FullCalendar as fallback |
| Calendar drag-to-resize complex to implement | Delays delivery | Fall back to date editing via detail panel |
| Over-styling action columns | Defeats Kanban principle | Trust board structure; resist decorative urgency |
| Mock data feels unrealistic | Weak demo | Use domain-representative German names, addresses, project titles |

---

## 14. Open Questions

Items to resolve before or during implementation:

1. **Custom calendar feasibility**: The spec defaults to a custom month grid. If it proves too costly, FullCalendar is the fallback — but it must fit within the 150kB bundle budget.
2. **Kanban drag-and-drop**: implement card dragging between adjacent columns, or rely solely on [→] button? Drag is more natural but adds a dependency (dnd-kit, ~15–20kB). Deferred to implementation.
3. **Column layout at 1024px**: 9 columns at tablet width — horizontal scroll, or group into 3 visual sections with sub-columns?
4. **`Erledigt` reversal**: currently terminal with no way back. If a payment bounces, should the project be able to return to `Abgerechnet`? Deferred — for the walking skeleton, terminal is simpler. Revisit when real payment tracking is implemented.

---

*Living document — updated as each iteration ships. Per-iteration deltas are in `docs/scope.md`; git history preserves past versions.*
