# Side pane

The column that shares the page. A side pane sits in the document flow beside
a board or list, separated by one hairline — no portal, no scrim, no shadow,
no layer. It is where a detail, a runner list, or an active review lives when
the person needs it *and* the content it describes at the same time.
Extracted from the source product's `SidePane` and `SidePaneHeader`
primitives (`src/renderer/src/components/ui/`).

It is deliberately **not** a drawer variant. The overlay family's defining
question is "does this surface cover the page?" — a drawer answers yes
(scrim, shadow, focus trap, `z.drawer`) and a side pane answers no. It is not
a raised surface either: it shares the panel's own background, so the hairline
does all the separating, exactly as the principles order — borders carry the
structure, shadows belong to overlays.

Use a drawer when the surface is summoned and dismissed; use a side pane when
it is part of the page's standing anatomy. A multi-pane surface built from
side panes has exactly one focused selection — every other pane's selection
rests (`patterns/selection`).

## Anatomy

| Part | Class | Required |
|---|---|---|
| Pane | `.ds-side-pane` | yes — `<aside>` for secondary content, `<section>` for a primary column; flex column, hairline on its inner edge |
| Header | `.ds-side-pane-header` | no — title, optional count, close; simpler asides only |
| Title | `.ds-side-pane-title` | with the header — `font.size.body` at `emphasis`, matching the panel-header rhythm so board and aside read as one family |
| Count | `.ds-side-pane-count` | no — display-only, `tabular-nums`; never hosts a control |
| Body | — | caller-owned scroll container: keyboard handlers and list semantics vary per surface, so the system does not pre-empt them |
| Resize handle | `.ds-side-pane-resize` | no — `role="separator"`, keyboard-operable, opt-in |

## Variants

- **Side** — `.ds-side-pane--left` / `.ds-side-pane--right`: which inner edge
  carries the hairline (`border.default`). A pane's outer edge is the panel's
  edge and draws nothing — no doubled borders where surfaces meet.
- **Width presets** — `.ds-side-pane--sm` (38%, 320–520px), `--md` (42%,
  320–560px, the default detail aside), `--lg` (44%, 320–560px, a primary
  content column). Percent of the panel with pixel rails, so the pane
  breathes with the window but can neither starve nor swallow its neighbour.
  The values are layout measures, not tokens.
- `.ds-side-pane--sunken` — `bg.app` instead of the inherited panel surface,
  for the quiet secondary asides (running agents, active review) that want a
  shade of distance from the lane. In light mode this is the one tone step
  the pane is allowed; it never adds a shadow to go with it.
- `.ds-side-pane--expanded` — the pane takes the whole row (the caller hides
  the neighbour). The hairline is dropped: there is nothing left to separate
  from.

## States

| State | Treatment |
|---|---|
| Rest | Hairline, inherited surface; nothing else |
| Resizing | The handle's 1px `accent.primary` guideline at full strength while the drag is live — accent as a hairline marking a genuinely live process, within budget |
| Handle hovered | The same guideline at reduced strength, as the reach-for affordance |
| Handle focused | The standard `focus.ring` at `focus.ring-offset` |
| Expanded | Full row, no hairline |

A persisted drag width overrides the preset but keeps the 320px floor and a
65% ceiling — CSS `max-width` beats the inline width when they conflict, so a
wide remembered pane cannot starve the board on a narrow window.

## Usage

**One hairline, on the inner edge.** The pane never draws its own box. If a
pane seems to need a full border, it is trying to be a card inside a panel —
reconsider the surface.

**The header is one chrome band.** Title left, count and close right,
`space.sm`/`space.lg` inset, one `border.default` rule beneath — a working
edge over the scrolling body, matching the drawer's header. A toolbar stacked
under it is the second band the composition rules exist to prevent.

**Resize is opt-in and fully keyboard-operable.** The handle is a
`role="separator"` with `aria-orientation="vertical"`: arrow keys step the
width 16px toward or away from the divider, Home (and double-click) resets to
the preset. The drag captures the pointer on the handle itself, because panes
routinely host iframes that would otherwise swallow `pointermove` mid-drag
and leave the resize stuck.

**Element choice is a semantic claim.** `<aside>` for the pane that supports
the main flow; `<section>` (with an accessible name) when the column *is* the
main flow — an inbox column is not an aside to its own detail.

**Rebuilding it in a framework:** what must survive is the flow-not-overlay
nature (no portal, no trap — Tab passes through), the inner-edge hairline,
the clamped width contract, and the separator keyboard behaviour.

## Accessibility

- The pane carries `aria-label` or `aria-labelledby` — a `<section>` requires
  one to be exposed as a landmark, and an `<aside>` with several siblings
  needs the disambiguation.
- No focus trap and no scroll lock: the pane is page content. Tab order runs
  through it in document order.
- The resize handle is focusable, visibly focused via `focus.ring`, and
  operable by keyboard with the same result as the drag. Its `aria-label`
  names the pane it resizes ("Resize review pane").
- The close button's label names what it closes — "Close running agents",
  not "Close" — because several side panes can be open in one view.
- The count is display-only. A count that should be clickable is a filter,
  and belongs in the body, not the header.
