# Design Notes for Walking Skeleton

Visual reference: [vue-prototype-reference.png](vue-prototype-reference.png) (Vue prototype D)

## Details to carry into the React implementation

These are implementation quality touches, not framework-specific — any stack can do them.

### Column backgrounds by state type
- **Action columns** (Anfrage, Beauftragt, Rechnung fällig): warm yellow/amber background, full column height. Makes them visually distinct without per-card decoration — aligns with the core UX principle that the board structure IS the visibility mechanism.
- **Buffer columns**: subtle blue tint.
- **Active column** (In Arbeit): subtle green tint.
- **Done column** (Erledigt): neutral gray.

### Summary badges
- Action state counts use warm-colored badges matching the column: `2× Anfrage`, `3× Beauftragt`
- Aged buffer counts use a distinct style: `1 Angebot seit >14 Tagen`
- Compact, scannable at a glance

### Other
- Favicon (browser tab identity)
- Column headers: state label + count in parentheses
- Cards: minimal — color dot, number, title, customer, dates, forward button
