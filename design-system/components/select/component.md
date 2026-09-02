# Select

One value out of a closed list, chosen rarely and read often. The trigger shows
the current value at rest; the popup exists only for the moment of changing it.
Extracted from the source product's select-only combobox
(`src/renderer/src/components/ui/Select.tsx`), which implements the WAI-ARIA
1.2 pattern: the trigger is the combobox, the popup is a listbox, and focus
never leaves the trigger.

Use it for four or more options, or for options that arrive from data. Two to
four short, equal-weight labels belong to a segmented control, where every
option stays visible. A choice that needs filtering-as-you-type is a combobox
with an input — a different component this system does not yet define; do not
grow this one into it.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Trigger | `.ds-select` | yes — a real `<button>` with `role="combobox"` |
| Value | `.ds-select-value` | yes — the selected label, or the placeholder; truncates |
| Chevron | `.ds-select-chevron` | yes — `aria-hidden`, points down in every state |
| Popup | `.ds-select-listbox` | yes — `role="listbox"`, a standard popover surface |
| Option | `.ds-select-option` | yes — `role="option"`, one per choice |
| Check | `.ds-select-check` | on the selected option only |

The trigger sits at `size.control.sm` — the height of every labelled control,
so a select and an input on the same row share a baseline. The popup opens at
least as wide as its trigger, caps its height and scrolls past ~8 rows, and is
an overlay surface: `bg.surface-raised`, `border.strong`, `radius.overlay`,
`shadow.popover`, `z.popover`.

The chevron does not flip while open. It is an affordance ("this opens"), not a
state indicator — the visible popup is the state.

## Variants

- Default (no modifier) — neutral chrome: `bg.surface-raised`,
  `border.default`, value in `text.default`.
- `ds-select--warn` / `ds-select--danger` — the selected value carries risk (a
  permissions bypass, a destructive default). The trigger takes the tone's
  **soft** tint with a transparent border, and the value takes the tone ink;
  the option restates the same ink in the list. This is a property of the
  *selected value*, not of the control — a select whose every option is toned
  is misusing it.
- **No accent or success emphasis, deliberately.** The source component's tone
  type technically admits them; the system does not. Emphasis on a trigger
  means "look again before you rely on this" — risk. A good choice is the
  normal case and earns no color, and the accent belongs to the primary
  action, not to a value display.
- **No size variants.** One control height; density comes from layout, not
  from smaller selects.

## States

| State | Treatment |
|---|---|
| Rest | `border.default` on `bg.surface-raised` |
| Hover | Border lifts to `border.strong`, value to `text.primary` — no background change |
| Open | Popup visible; the trigger does not restyle — the popup is the signal |
| Focus | `focus.ring` outline at `focus.ring-offset`, on `:focus-visible` only |
| Disabled | 45% opacity, `not-allowed` cursor |
| Placeholder | No selection yet: value in `text.muted` |
| Option active | `bg.hover`, label lifts to `text.primary` — pointer and keyboard share it |
| Option selected | Trailing check in `accent.primary` (accent as ink — inside the budget) |
| Option disabled | 45% opacity, `not-allowed`; skipped by every keyboard path |

Active follows the keyboard *and* the pointer — `mouseenter` moves it, so there
is never one row highlighted by hover and a different one by arrow keys.

## Keyboard

The whole contract, and all of it required:

| Key | Closed | Open |
|---|---|---|
| ArrowDown / ArrowUp | Opens, active on current value | Moves active; skips disabled; wraps |
| Home / End | — | First / last enabled option |
| Enter / Space | Opens | Selects the active option, closes |
| Escape | — | Closes without selecting; focus stays on the trigger |
| Printable character | Opens and starts type-ahead | Type-ahead: prefix match on a buffer that resets after ~500 ms |

Focus never enters the popup. The trigger keeps DOM focus and points at the
active option with `aria-activedescendant`; options take no tab stop. This is
what makes Escape cheap and focus restoration a non-event.

## Usage

- The trigger shows a value, not a prompt. Once something is selected the
  placeholder never returns; prefer a real default over a placeholder at all.
- Label the control with the `field` component or an `aria-label` — the value
  is not the name. A select whose meaning is only inferable from its current
  value is unreadable at rest.
- Order options by the domain (severity, recency, pipeline order),
  alphabetically only when no better order exists. Type-ahead assumes labels
  with meaningful first words.
- Show unavailable options as disabled rows only when their existence is
  information; otherwise omit them. A menu of mostly-dead rows is a fake
  affordance.
- Selecting closes immediately. A select is one choice, not a checklist —
  multi-select is a different component.

## Accessibility

- The trigger is a `<button>` with `role="combobox"`, `aria-haspopup="listbox"`,
  live `aria-expanded`, `aria-controls` naming the listbox id, and a required
  accessible name (`aria-label` or a wired `<label>`).
- While open, `aria-activedescendant` on the trigger tracks the active option's
  id; each option carries `role="option"`, `aria-selected` on the current
  value, and `aria-disabled` where relevant.
- Selection is conveyed by `aria-selected`, with the check glyph `aria-hidden`
  as its visual echo — never by the glyph alone, and never by color alone.
- The active option is kept in view (`scrollIntoView`, nearest block) as the
  keyboard moves it through a scrolling popup.
- Toned values keep their meaning without color: the tone marks risk the
  *label* must also state ("Bypass checks"), so grayscale loses emphasis, not
  information.

## Known drift

- ~~`Popover.tsx` (the popup's surface in the shipped kit) hardcodes a
  dark-mode shadow literal instead of `--sem-shadow-popover`, so light-mode
  popups cast a dark-tuned shadow.~~ **Resolved 2026-09-02** — verified absent
  from the renderer; see `popover/component.md` for the same entry.
- Shipped option rows and trigger use ad-hoc pixel paddings that land on the
  space scale but bypass the variables. Token canon: option padding
  `space.md` / `space.xs`. This is the tree-wide spelling convention rather
  than a defect in this component — the option rows take `MENU_ROW_CLASS`, so
  the inset is spelled once for the whole menu family — but the spelling still
  does not track the variable.
