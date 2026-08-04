# Tabs

The view switcher inside a panel: a row of peers, exactly one active, the
active one marked by an accent hairline underline and an ink lift — never an
accent fill. Extracted from the shipped `Tabs` primitive
(`src/renderer/src/components/ui/Tabs.tsx`), whose underline treatment the
conformance tests lock: the only elements allowed to carry accent fill are
1px hairlines.

Use tabs when the choices are views of the same content region. Use a
segmented control when they are values of a setting, and the context rail
when they are destinations.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Tab list | `.ds-tabs` | yes — `role="tablist"` with an `aria-label`, one bottom hairline |
| Tab | `.ds-tab` | yes — `role="tab"` buttons, `font.size.meta` |
| Icon | `.ds-tab-icon` | no — a leading glyph, `aria-hidden` |
| Count | `.ds-tab-count` | no — canonical count, tabular, `font.size.micro` |
| Underline | `.ds-tab-underline` | yes — the 1px active marker, `aria-hidden` |
| Panel | `.ds-tab-panel` | yes — `role="tabpanel"`, a focusable scroll region |

Tabs sit `size.control.sm` (30px) tall at `space.lg` inline padding, spaced
by `space.3xs`. Each tab overlaps the row's hairline by 1px so the active
underline draws **on** the border, not above it — one line, two meanings.
The underline is inset `space.sm` from each end of its tab: it marks the
label, not the hit area.

## Variants

- **Default** — the row draws its own `border.subtle`-weight structure with a
  `border.default` hairline.
- **`--borderless`** — no hairline; a parent container owns the row's border.
  Needed when the tab row shares its band with trailing inline controls —
  one chrome band, one line.

## States

| State | Treatment |
|---|---|
| Rest | `text.muted`, transparent underline |
| Hover | Ink lifts to `text.primary`. No background — the underline idiom marks tabs, not a fill |
| Active | `text.primary` + the accent hairline underline. Never an accent fill or a pill |
| Focus-visible | `focus.ring` |
| Disabled | `opacity: 0.5`, `cursor: not-allowed` |

## Usage

**The underline is the whole treatment.** An active tab is an ink lift plus a
1px accent line. A filled tab, a tinted pill, or a raised card is a second
accent idiom and a reject-on-sight.

**Selection follows focus.** Arrow keys move focus *and* activate: Left/Right
step through enabled tabs with wraparound, Home/End jump to the ends. This is
the correct model when switching panels is cheap; if a panel is expensive to
mount, keep roving focus but activate on Enter/Space instead — pick one model
per product and hold to it.

**Roving tabindex.** Exactly one tab is in the tab order at any time — the
active one. Tab from the active tab lands in the panel, not on the next tab.

**Counts are canonical.** A count on a tab is the count of that view. Do not
repeat it inside the panel where the two could disagree.

**The panel is a tab stop.** It is usually a scroll container, so it takes
`tabindex="0"` — otherwise keyboard users cannot scroll it. Only the active
panel is rendered; inactive panels are unmounted, not hidden.

## Accessibility

- The tablist carries a required `aria-label` naming what the tabs switch
  ("Inbox views"). Tabs are `<button role="tab">` with `aria-selected` and
  `aria-controls` pointing at their panel's `id`.
- The panel carries `role="tabpanel"` and `aria-labelledby` pointing back at
  its tab, so its accessible name is the tab's label.
- The panel's focus indicator is the ring drawn **inward** (a negative
  `focus.ring-offset`): it sits at the edge of a scrolling region, where an
  outward ring is clipped. Without it a focusable panel falls back to the UA
  outline — the one treatment the system cannot theme.
- Icons on tabs are `aria-hidden`; the label carries the name. An icon-only
  tab is not a variant this component has.
- Disabled tabs keep their label readable (`opacity`, not an ink swap to
  `text.disabled` alone) and are skipped by arrow navigation.

## Known drift

All in `src/renderer/src/components/ui/Tabs.tsx`, unfiled — fold into the
next tabs pass:

- Tabs render 32px tall (`h-8`); the control ramp has no 32px step. Canon is
  `size.control.sm` (30px) — the default for a labeled control.
- Tab icons render at 14px (`h-3.5`); the icon ramp has no 14px step. Canon
  is `icon.size.xs` (13px).
- Disabled tabs ship `opacity-45`; the system-wide disabled treatment
  (list-row, task-card) is 0.5.
