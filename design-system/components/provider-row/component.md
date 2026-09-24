# Provider row

One row for a *provider*: something the product talks to that can be
present-or-absent, healthy-or-not, and configured per-instance. An agent CLI, a
source-control forge, an MCP server, a capability module. Extracted from the
source product's Agent CLIs lists.

It is not the general list row. Reach for `list-row` when the thing in the row
is content the user made; reach for this when the row reports on something
outside the product that the product depends on.

Two facts drive the whole anatomy, and they are separate: **health** (is it
reachable) and **enablement** (do you want it on). A provider can be switched on
and unreachable, or off and perfectly installed. Nothing here derives one from
the other.

## Anatomy

- `ds-provider-row` — the group. It owns the row and its expansion, so a
  disclosure opens inside the row's own box rather than pushing a sibling panel
  into the list.
- `ds-provider-row__face` — the resting row: `space.lg` of vertical padding,
  `space.md` at the sides, and **no border**. Five bordered bars in a list read
  as five panels; space and the hover fill do the separating. Where the list
  itself is a settings group or a catalogue page, the *list* takes one edge —
  the list card — and the rows inside it are still borderless, divided by the
  card's hairlines (the `--in-card` variant below).
- `ds-provider-row__mark` — the brand mark's slot at `icon.size.lg`. The row
  sizes the slot and never picks the mark: a provider whose identity is a logo
  and one whose identity is a glyph must read at one weight.
- `ds-provider-row__health` — 6px of status colour docked on the mark's TOP-LEFT
  corner inside a 2px keyline in the fill behind it. The keyline is structural,
  not decoration: without it the dot reads as a stain on the logo. **Optional
  since 2026-09-10** — see "One status idiom" under Usage.
- `ds-provider-row__badge` — the `badge` component's corner count, docked on the
  mark's TOP-RIGHT: how many things on this row are waiting for the person. The
  opposite corner from the dot, so a row that somehow draws both reads as two
  marks rather than one smudge.
- `ds-provider-row__name` + `ds-provider-row__version` — a baseline pair, name at
  `font.size.body` / `font.weight.emphasis`, version mono at `font.size.micro`.
  Neither grows, so they stay adjacent on a row with no trailing control.
- `ds-provider-row__state` — exactly one line, at `font.size.meta`.
  `ds-provider-row__id` marks identifiers inside it.
- `ds-provider-row__trail` — actions, then the disclosure chevron, then the
  switch. It owns its own clicks: flipping the switch must not also toggle the
  row.
- `ds-provider-row__detail` — the expansion, indented to the name's left edge.
- The section band above the list is the one chrome row: title left, freshness
  meta and the controls that act on the whole list right. Not part of this
  component, but a list of these rows without it has nowhere to put "when was
  this last checked" and the control that re-checks it.

## Variants

- Default — icon, name, state line. The floor: every provider row has all three.
- Versioned — adds the mono version. **Absent means nothing is rendered there.**
  A row that says "unknown" where a version goes has spent a high-signal slot on
  the absence of information.
- Switched (`__switch` present) — adds enablement. Only for a host with real
  enablement state to write to.
- Disclosable (`ds-provider-row--disclosable`) — adds the chevron and the
  expansion.
- Selected (`ds-provider-row--selected`) — Tier 1 selection for a list that
  drives a detail pane: a neutral fill, no left bar, no accent.
- Badged (`__badge` present) — a count on the mark's corner. Often "1", and that
  is not a mistake: on a row the counter's job is *this one, here*, and the
  number is what makes it a pip rather than one more status colour.
- Recessed (`ds-provider-row--recessed`) — the provider is not present on this
  machine. The mark drops to 60% and the name drops from `text.primary` to
  `text.muted`; nothing else changes. `text.muted` rather than the one step to
  `text.default`, which sat too close to the present rows to read as receded
  (owner ruling 2026-09-24), and rather than `text.subtle`, which falls under AA
  on the dark card. **Not a disabled state** — every control
  keeps working, and the Install button such a row carries is the reason it is
  listed at all.
- In a card (`ds-provider-row--in-card`) — the row inside the list card
  ([setting-row](../setting-row/component.md) → *The list card*, ruled
  2026-09-15). The face drops its radius and takes the card's `space.xl` side
  inset; the health dot's keyline and the corner count's ring follow the
  card's raised ground so neither halos. Everything else — the axes, the
  disclosure, the expansion's alignment to the name — is unchanged.
- **No tone variants of the row itself, deliberately.** An unhealthy provider is
  reported by its dot and its state line, not by tinting the row. A list where
  three of nine rows carry a wash has no resting state left.

## States

- Hover: `bg.hover` on the face, and the dot's keyline switches to the same fill
  so it does not halo. Rows separate by this fill — it is load-bearing, not
  feedback.
- Selected: `bg.selected`, keyline follows again.
- Expanded: the chevron rotates 180°; the face does not change fill. The row
  keeps its position, and the detail opens under it.
- Health: `good` / `warn` / `danger` / `neutral` on the dot. `neutral` is the
  honest tone where a host has no health probe (a marketplace listing) — it is
  not a fourth severity.
- Unknown health is a real state and not the same as unhealthy. Where a probe
  failed rather than reported absence, say so on the state line and do not offer
  the action that assumes absence.
- Reduced motion: the chevron's rotation is switched off. The state still reads
  from the angle, so nothing is lost.
- No press-scale, no row-level motion. A list of nine rows that each spring on
  click is nine springs.

## Usage

- **The state line is mandatory, and it is state.** "Authenticated as `<id>` ·
  Max subscription", "Not installed — no `grok` on PATH", "Unavailable — startup
  timed out after 15s". Never what the provider is or why you might want it —
  that is a caption, and it belongs to a marketplace detail panel if anywhere.
- **The dot is never the only carrier of a state.** It is `aria-hidden` and the
  words are what a screen reader gets, which is also what makes the row survive
  greyscale and colour-blindness.
- **One status idiom, and the list picks which one.** The dot and the corner
  count are both optional and a list uses one or the other — never both, and
  never either alongside a tinted pill saying the same thing.

  Which one is decided by what the list is FOR, and the deciding question is
  what the rows differ by. The dot earns its place where health genuinely varies
  down the column. Where it does not — an Agent CLIs list where nine of ten rows
  probe green — it is a status idiom spent on a fact nobody is scanning for, and
  it crowds out the mark that does have something to say. The owner arrived at
  exactly that list from an update notification and could not tell which CLI the
  notification was about (2026-09-10): ten dots, all the same, and the one thing
  they came for was not among them. The count replaced them.
- **A count says which, not how many.** On a rail square it is a quantity; on a
  row it is a pointer. Give it the row's own name in its accessible label
  ("Codex — update available: 0.153.4") — a bare "1" docked on a logo is not a
  sentence.
- **Recede absence, do not grey it out.** A provider the machine does not have
  belongs in the list — that is how it gets installed — but it should not hold
  the same weight as one that is there. Recede it and leave its controls alone.
  A list that mixes the two puts the present ones first, in their usual order,
  and the receded ones after them in the same order, so the list reads as what
  is here and then what could be.
- Do not render a switch a host cannot honour. A toggle wired to nothing is
  worse than no toggle: it reports a state the product does not have.
- Do not render a disclosure over an empty panel. Where a provider has nothing
  to configure on this surface, the row ends at its state line.
- Offer an action only when the state earns it. An Install button on a provider
  whose probe never completed is a fake affordance — that row's next action is
  to check again.
- Keep the expansion the per-instance form that already exists. This is
  disclosure, not navigation: nothing about opening a row changes where the user
  is.
- **A settings group or a catalogue page of these rows takes the list card**
  (ruled 2026-09-15); a rail, a shelf or an onboarding step does not. The
  section band sits outside the card with the count and the one control that
  acts on the whole list; the rows sit inside it in the `--in-card` form.
  Rows loose under a band on a settings page were the shape this replaced.

## Accessibility

- The chevron is a real `<button>` carrying `aria-expanded` and `aria-controls`
  on the panel it opens, plus an `aria-label` naming its provider ("Claude Code
  details") — a list of nine identical "details" is nine unusable controls.
- Exactly **one** focusable control per disclosure. The face is a mouse target
  that calls the same handler; it is not a second tab stop and never a
  `role="button"` wrapper around a real button.
- The switch is the `switch` component's contract: `role="switch"`,
  `aria-checked`, Space toggles and Enter does not.
- The health dot is `aria-hidden`; the state line is plain text in the reading
  order right after the name, so the row announces as name, version, state.
- The corner count is the opposite: **always named, never decorative**, because
  nothing else on the row says what it counts. It is the badge component's
  count species, so it announces as a live region — the number moving while the
  reader is elsewhere is exactly what that is for.
- Recessed is a contrast change and nothing else. It sets no `aria-disabled`,
  removes nothing from the tab order, and adds no state to the announcement —
  the state line already carries the fact in words. The receded name's
  `text.muted` clears AA on the row's ground and on its hover fill in the
  system's light and dark modes (at worst 4.7:1, light, hovered) — the same
  ink the state line has always worn there. It does not clear AA on
  `bg.selected` (3.9:1, light), so a row that is both selected and recessed
  keeps `text.primary` on its name; the mark still recedes.
- Focus-visible is a 2px `border.focus` mark on the chevron and the switch
  independently — a ring on the chevron, an offset outline on the switch, whose
  checked fill is `border.focus`'s own colour. The row itself never takes focus,
  so it never shows either.
- The chevron pads out to `size.hit-target-min` around its `icon.size.xs` glyph.
  The glyph is what you see; the button is what you hit.
- The face takes a hover fill only when it is disclosable. A fill on hover is
  this system's promise that the thing under the cursor is actionable, and a
  row whose only live control is a trailing button cannot keep it.
- Contrast: name, state line, and mono identifiers all clear AA in both modes.
  The dot is exempt because it is decorative by contract — but the 2px keyline is
  what keeps it perceptible at all against a brand mark, so it is not optional.
