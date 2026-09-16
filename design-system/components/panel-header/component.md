# Panel header

The one header contract for every panel: a single 34px band carrying the
panel's name, its canonical count, an optional scope word, and at most two
controls. Extracted from the shipped `PanelHeader` primitive
(`src/renderer/src/components/ui/PanelHeader.tsx`); MC-2112 rolls this anatomy
out to every panel that still draws its own header.

A panel gets exactly one of these. A header stacked on a toolbar is the
two-bands-of-chrome defect the principles reject on sight — the controls
belong in this band, and a status belongs to the thing that has it.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Header | `.ds-panel-header` | yes — a `<header>` band, `bg.surface`, one bottom hairline |
| Identity dot | `.ds-panel-header-identity` | no — 6px, colored by the consumer's identity channel |
| Title | `.ds-panel-header-title` | yes — an `<h2>`, `font.size.body` at `font.weight.emphasis`, `text.primary`, truncates |
| Count | `.ds-panel-header-count` | no — the canonical count, mono-free, tabular, `text.muted` |
| Scope | `.ds-panel-header-scope` | no — one word of context after a `·` separator |
| Actions | `.ds-panel-header-actions` | no — the primary action and an overflow trigger, nothing else |
| Progress | `.ds-panel-header-progress` | no — a 2px completion hairline overlaying the bottom border |

**The band is 34px** (`size.control.md`): `space.sm` block insets around a
body-size title line. Inline insets are `space.lg`. Everything in the band
centers on one baseline; nothing wraps.

**The title truncates, the scope evaporates.** The scope word gives up its
space first and disappears entirely before the title loses a character — a
panel that clips its own name to "Bac…" while a scope word sits whole beside
it has the priority backwards. Pair the title with `truncated-text` so the
full name is recoverable when it is actually cut off.

## Variants

- **Default** — bottom hairline at `border.default`. This is the panel's
  chrome edge.
- **`--flush`** — no hairline. Use only when a search row follows
  immediately: one divider per panel, and it belongs under the search — that
  is the line that says "the list starts here" (see `patterns/list-surface`).
  A rule above the search as well boxes it into a strip of its own.

## States

| State | Treatment |
|---|---|
| Rest | `bg.surface`, title at `text.primary` |
| With progress | The 2px hairline sits on the bottom border, accent fill for done, `status.warn` segment after it for blocked |
| Progress change | Width animates at `motion.duration.normal`, `motion.ease.standard` |

The header itself has no hover, selected, or disabled state — it is chrome,
not a control. Its actions carry their own states.

## Usage

**One primary action, then overflow.** The actions slot holds at most one
labeled action and one overflow trigger. A second visible control means the
first two are competing; move it into the overflow menu.

**The count is the canonical count.** Render it here or in the content, never
both — two counts that could disagree are the defect the principles name.

**The identity dot is identity, not status.** It marks which tool owns the
panel, using the consumer's identity color channel (`--ds-panel-header-identity`
— the app supplies its per-tool value; there is no `sem.*` token for tool
identity, deliberately). It never pulses, never changes tone, and the rest of
the panel stays accent-neutral around it. Status belongs to rows and status
dots, not to the header.

**The progress hairline is earned.** Attach it only when the panel has a
canonical completion metric (accepted of total). It is not decoration, not a
loading bar, and not a second accent — it is the accent-as-hairline marking
real progress, which the accent budget permits.

**No status chips, no counts line, no subtitle sentence.** The panel under
the band already shows its own state. A scope word ("This project") is the
ceiling; a sentence is a redesign signal.

## Accessibility

- The band renders as `<header>`; the title is a real `<h2>` so the panel
  lands in the document outline. Give it an `id` when a region's
  `aria-labelledby` points at it.
- The identity dot is `aria-hidden="true"` — the title already names the
  panel; the dot only colors it.
- The progress hairline carries `role="progressbar"` with `aria-valuemin`,
  `aria-valuemax`, `aria-valuenow`, and an `aria-label` that states the metric
  ("3 of 7 milestones accepted"). A 2px line is invisible to a screen reader
  without it.
- Overflowed controls stay reachable: anything demoted to the overflow menu
  is still in the tab order once the menu opens.

## Known drift

- `PanelHeader.tsx` animates the progress fill over `200ms`; the motion ramp
  has no such step. Canon is `motion.duration.normal` (180ms). Fold into the
  MC-2112 rollout.
