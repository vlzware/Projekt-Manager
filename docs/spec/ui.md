# UI Specification

*Iteration 5 — April 2026 | Living document — updated as each iteration ships.*

## 8. UI Specification

### 8.1 Layout

The application has two top-level layout states depending on authentication.

#### 8.1.1 Unauthenticated State

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│                     App Name / Logo                      │
│                                                          │
│                    ┌──────────────┐                      │
│                    │  Benutzername│                      │
│                    ├──────────────┤                      │
│                    │  Passwort    │                      │
│                    ├──────────────┤                      │
│                    │  [Anmelden]  │                      │
│                    └──────────────┘                      │
│                                                          │
│                    (error area)                          │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

The login screen is minimal: app name/logo, username field, password field, a submit button labeled "Anmelden", and an error area for failed attempts. The server returns a generic error message on failed login — no distinction between "user not found" and "wrong password" to avoid information leakage. The client displays the server-provided message. The generic behavior is enforced server-side, not client-side. No registration link, no password recovery (both out of scope).

The login screen is the **only** view available to unauthenticated users. No project data is accessible without authentication.

#### 8.1.2 Authenticated State

```
┌──────────────────────────────────────────────────────────┐
│  Header: App Name  |  [Kanban] [Kalender]  |  Summary    │
│                                    [Maria Schmidt ▾]     │
├──────────────────────────────────────────────────────────┤
│                                                          │
│                     Active View                          │
│               (Kanban or Calendar)                       │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  Footer: configurable text [C]                           │
└──────────────────────────────────────────────────────────┘
```

- **Header**: app name **[C]**, view toggle (Kanban / Kalender), summary indicators.
- **User indicator**: displays the authenticated user's `displayName`. Clicking reveals a minimal dropdown with a single entry: "Abmelden" (logout).
- **Default view**: Kanban (the primary overview tool). Toggling switches between views.
- **Footer**: text driven by branding config **[C]**. Default: `"Projekt-Manager"` **[C]**. No longer says "Walking Skeleton · Mockdaten".
- **Responsive target**: 1920×1080 desktop monitor and tablet (1024×768 minimum). Mobile is out of scope.

---

### 8.2 Kanban View

#### 8.2.1 Columns

The board has **9 columns**, one per workflow state (see [index.md — Workflow States](index.md#3-workflow-states)). Each column header shows the German label and the card count.

Action columns are visually distinct from buffer columns (e.g., warm-tinted background for action, neutral for buffer). This distinction makes the board structure itself communicate which columns demand attention.

With 9 columns, horizontal scrolling may be needed on narrower screens. At 1920px, each column gets ~200px — tight but workable.

#### 8.2.2 Project Card

```
┌─────────────────────────────┐
│ [●] 2026-042                │
│ Fassadenanstrich Müller     │
│ Familie Müller              │
│ 14.04. – 18.04.2026         │
│                        [→]  │
└─────────────────────────────┘
```

- **[●]** Color dot matching the state color (see 8.6).
- **Project number** and **title**.
- **Customer name**.
- **Date range** if available; `"Kein Termin"` otherwise.
- **[→] button** advances to the next workflow state. Confirmation dialog: `"Status ändern: Geplant → In Arbeit?"` with OK / Abbrechen. Hidden for `Erledigt` cards.

Cards within a column are sorted by `statusChangedAt` ascending (longest-waiting on top).

#### 8.2.3 Entry Date and Aging

Every card shows its `statusChangedAt` as a small date label (e.g., `"15.03.2026"`). The date is displayed as a standalone label (e.g., `15.03.2026`), not prefixed. The `"seit X Tagen"` aging text is a separate indicator that appears below for aged buffer cards. This makes the age of every card visible regardless of state type. For aged buffer cards, the `"seit X Tagen"` text appears below the date label — both are shown.

**Action states**: after a configurable threshold (`agingBoldDays`), the entry date turns **bold** — a subtle but clear flag that this item has been waiting too long. Default thresholds **[C]**:
- Anfrage: 3 days
- Beauftragt: 5 days
- Rechnung fällig: 3 days

**Buffer states**: after a configurable threshold (`agingThresholdDays`), the entry date turns bold and the card additionally shows `"seit X Tagen"` as a text indicator. Default thresholds **[C]**:
- Angebot: 14 days
- Geplant: 21 days
- Abnahme: 7 days
- Abgerechnet: 30 days

#### 8.2.4 Interactivity

- **Click on a card** → opens the Project Detail Panel (8.4).
- **[→] button** → state transition with confirmation dialog.
- **Drag between adjacent columns** → optional. If implemented, only adjacent-column drops are accepted (no skipping states).

---

### 8.3 Calendar View

#### 8.3.1 Display

- **Default**: month view of the current month. Navigation to previous/next months.
- **Week view toggle**: available but secondary.
- Projects with `plannedStart` and `plannedEnd` render as **horizontal bars** spanning those dates.
- Projects with only `plannedStart` (no `plannedEnd`) render as a **single-day block** on the start date.
- Bar color encodes the workflow state (see 8.6).
- Projects without planned dates do **not** appear. A counter below the calendar reads: `"X Projekte ohne Termin"` — clicking it switches to Kanban view.

#### 8.3.2 Interactivity

- **Click on a project bar** → opens the Project Detail Panel (8.4).
- **Date editing** is done via the Project Detail Panel (8.4). Calendar drag-to-resize is deferred.

---

### 8.4 Project Detail Panel

A **slide-in panel** from the right side (not a modal — the user retains context of the view behind it). Width: ~400px on desktop.

Contents:
- Project number, title (large)
- Current status with colored badge + German label
- **"Nächster Schritt" button** → forward transition (same as [→]). Hidden for `Erledigt`.
- **"Vorheriger Schritt" button** → backward transition, styled less prominently. Hidden for `Anfrage` (no previous state) and `Erledigt` (terminal).
- Customer: name, phone (`tel:` link), email (`mailto:` link)
- Address: full address with Google Maps link (`https://www.google.com/maps/search/?api=1&query={street}+{zip}+{city}`)
- **Dates: planned start/end** — editable via date picker inputs. Changes update `plannedStart`/`plannedEnd` and are reflected in both views immediately. The UI prevents invalid combinations: clearing `plannedStart` while `plannedEnd` is set also clears `plannedEnd` (see [data-model.md §6.8](data-model.md#68-date-validation)).
- Assigned workers (list of names)
- Estimated value, formatted as `8.500,00 €` (German locale)
- Notes (read-only)
- Timestamps: created, last updated, status changed

Editing beyond state transitions and dates is **not** in scope.

---

### 8.5 Summary Area

Displayed in the header. Shows aggregate counts computed from current project data:

- Count of projects in each action state: e.g., `"3× Rechnung fällig"`, `"2× Anfrage"`
- Count of projects in buffer states exceeding aging thresholds: e.g., `"1 Angebot seit >14 Tagen"`

Clicking an indicator filters the current view to show only the affected projects. For action-state indicators, this filters to all projects in that state. For aged buffer indicators, this filters to only the projects exceeding the threshold (not all projects in that buffer state). Implementation note: the filter state must distinguish between 'all projects in state X' (action-state filter) and 'only aged projects in state X' (buffer-aging filter). See [#81](https://github.com/vlzware/Projekt-Manager/issues/81). Non-matching cards are hidden (not dimmed). A `"Filter aufheben"` (clear filter) button appears in the summary area while a filter is active. Switching views clears the filter.

Summary values update immediately after any state change.

---

### 8.6 Color Coding

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

Colors are configurable via the state configuration (see [Data Model — State Metadata](data-model.md#52-state-metadata)). The warm/cool grouping is the design principle; exact values may be adjusted during implementation.

---

## 9. Behavioral Rules

### 9.1 State Transitions

- **Forward**: to the next state in the sequence. Allowed from any state except `erledigt`.
- **Backward**: to the immediately preceding state. Allowed from any state except `anfrage` (no previous) and `erledigt` (terminal).
- **No skipping**: direct jumps across multiple states are not allowed.
- **Terminal**: `erledigt` is a terminal state — no forward or backward transitions. Both transition buttons are hidden in the UI. The domain function `getPreviousState('erledigt')` returns `null` (not the actual predecessor) — terminality is a domain rule, not just a UI rule.
- **Cancellation**: not in scope.

Every transition shows a confirmation dialog in German before executing: `"Status ändern: {current} → {target}?"` with OK / Abbrechen.

Enforcement happens both server-side (API rejects invalid transitions) and client-side (buttons hidden as before). Server-side enforcement is authoritative.

Design note: `Erledigt` is terminal — no backward transition. Reversal (e.g., for bounced payments) is deferred to the iteration that introduces real payment tracking.

### 9.2 Inaction Visibility

Visibility is provided by three mechanisms:

**Board structure** (primary): action columns with accumulated cards are immediately visible. The column IS the signal.

**Entry date on every card**: every card shows its `statusChangedAt` date. This makes age visible at a glance regardless of state type. After a configurable threshold, the date turns **bold** — a clear flag without decorative excess.

**Buffer aging text** (for buffer states only): cards exceeding their `agingThresholdDays` additionally show `"seit X Tagen"` as a text indicator, since buffer-column accumulation is normal and doesn't inherently signal a problem.

Thresholds are defined in the state configuration (see [Data Model — State Metadata](data-model.md#52-state-metadata)) and listed in section 8.2.3.

### 9.3 Date Handling

- All dates displayed in German format: `DD.MM.YYYY` or `DD.MM.` when year is obvious. **[C]** Display dates (card labels, timestamps, calendar headers) use German format. Date input controls (e.g., date pickers in the detail panel) render in the user's browser locale — the system respects the user's locale settings for interactive inputs.
- Week starts on **Monday** (ISO 8601 / German convention). **[C]**
- No time zones — all dates are local calendar dates.

Date and locale display settings are company-configurable (see [architecture.md §12.2](architecture.md#122-company-configurable-settings)).

### 9.4 Authentication Behavior

- On app load, the client checks for an existing valid session. If valid → load authenticated view. If expired or absent → login screen.
- After successful login, the client fetches the full project list and renders the default view (Kanban).
- Logout clears the local session and returns to the login screen.
- Session expiry while the app is open (detected by an API request returning an authentication error) → redirect to login with message: `"Sitzung abgelaufen. Bitte erneut anmelden."` **[C]**
- The login screen is the **only** view available to unauthenticated users. No project data is accessible without authentication.
- After logout, the browser back button must **not** reveal project data.

### 9.5 Asynchronous Mutation Behavior

Mutations (state transitions, date updates) go through the API (see [API](api.md)). The UI must handle:

- **Loading state**: brief indicator (disabled button, spinner) while mutation is in flight. No double-submit on the same project.
- **Optimistic update**: the UI may update locally before the server responds, but must reconcile with the server response (revert on failure).
- **Error feedback**: failed mutation shows German-language error message, reverts local state. `"Änderung fehlgeschlagen. Bitte erneut versuchen."` **[C]**

---

## 10. Responsive Behavior

The Kanban board uses a progressive column collapse to remain usable on narrower viewports. Columns are grouped into three tiers by priority. Action columns are always the last to collapse.

- **Below 1780px** — tier-3 columns collapse: Angebot, Abgerechnet, Erledigt. Collapsed columns show a slim indicator with the column header and card count. Cards are hidden.
- **Below 1350px** — tier-2 columns also collapse: Geplant, In Arbeit, Abnahme.
- **Below 940px** — tier-1 columns also collapse: Anfrage, Beauftragt, Rechnung fällig. Action columns are always the last to collapse.
- **Expanding**: clicking a collapsed column expands it. Clicking the column header again collapses it.

---

*Cross-references: [index.md](index.md) for workflow states and assumptions, [data-model.md](data-model.md) for entity definitions and state metadata, [api.md](api.md) for API operations, [verification.md](verification.md) for acceptance criteria.*
