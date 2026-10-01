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
| Resize handle | `.ds-side-pane-resize-handle` | `--resizable` only — a `role="separator"` straddling the inner edge; its guideline is `.ds-side-pane-resize-line` |
| Body | — | caller-owned scroll container: keyboard handlers and list semantics vary per surface, so the system does not pre-empt them |

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
- `.ds-side-pane--resizable` — the person sets the width by dragging the inner
  edge. The pane then carries a pixel width the host owns, clamped to rails
  the host declares (the editor window's file tree: 180–480px, 260px by
  default), instead of a percent preset. It is for a column the person keeps
  open while working beside it — the workspace pane, the editor window's file
  tree — where the right width depends on the names in it. A detail aside
  that opens and closes with its selection keeps a preset.

## States

| State | Treatment |
|---|---|
| Rest | Hairline, inherited surface; nothing else |
| Expanded | Full row, no hairline |
| Handle hover (`--resizable`) | The guideline over the hairline fades in at 60% |
| Resizing (`--resizable`) | `.ds-side-pane-resize-handle--active`: the guideline at full strength for the length of the drag |

A preset pane's width is the preset's alone: it has no handle, so nothing
overrides the percent and its pixel rails. A `--resizable` pane's width is
the person's, within the host's rails.

## Usage

**One hairline, on the inner edge.** The pane never draws its own box. If a
pane seems to need a full border, it is trying to be a card inside a panel —
reconsider the surface.

**The header is one chrome band.** Title left, count and close right,
`space.sm`/`space.lg` inset, one `border.default` rule beneath — a working
edge over the scrolling body, matching the drawer's header. A toolbar stacked
under it is the second band the composition rules exist to prevent.

**Element choice is a semantic claim.** `<aside>` for the pane that supports
the main flow; `<section>` (with an accessible name) when the column *is* the
main flow — an inbox column is not an aside to its own detail.

**The resize drag is captured.** Panes routinely host iframes (and in the
app, `<webview>` guests) that would otherwise swallow pointermove mid-drag, so
the handle takes pointer capture on press and a transparent shield covers the
window for the length of the drag. The live width is written straight to the
element on each animation frame and committed once, on release — never a store
write per frame. In the app this is `startColumnResizeDrag`
(`components/workspace/columnResizeDrag.ts`), shared by every resizable column.

**Rebuilding it in a framework:** what must survive is the flow-not-overlay
nature (no portal, no trap — Tab passes through), the inner-edge hairline,
and the clamped width contract — for `--resizable`, also the captured drag and
the keyboard steps below.

## Accessibility

- The pane carries `aria-label` or `aria-labelledby` — a `<section>` requires
  one to be exposed as a landmark, and an `<aside>` with several siblings
  needs the disambiguation.
- No focus trap and no scroll lock: the pane is page content. Tab order runs
  through it in document order.
- The close button's label names what it closes — "Close running agents",
  not "Close" — because several side panes can be open in one view.
- The count is display-only. A count that should be clickable is a filter,
  and belongs in the body, not the header.
- The resize handle is a focusable `role="separator"` with
  `aria-orientation="vertical"`, an `aria-label` naming the pane ("Resize
  files"), and `aria-valuenow`/`-valuemin`/`-valuemax` in pixels. ←/→ step the
  width by 16px, Home restores the default, and a double-click does the same.
