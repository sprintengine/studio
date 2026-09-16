// The row surface classes a list row wears (door-rails-premium): the selected
// edge, the gold wash of a row that wants a person, and the green wash of one
// that finished unseen. The global surfaces' rails compose them through
// `globalSurface/surfaceSubstrate.tsx`.

/**
 * The selected row's edge, as a ring so it never moves the row. `--selection-edge`
 * rather than `--accent-primary` directly: the resting-tier rules in
 * assets/index.css rebind it to `transparent` on a pane that is not holding
 * focus, the same way they rebind the fill and the ink lift.
 */
export const SELECTION_EDGE_CLASS = 'ring-2 ring-inset ring-[color:var(--selection-edge)]'

/**
 * A row that wants a person: the gold wash, held on hover so hovering never
 * reads as the ask going away. The ink is the tone's on-tint mix so the title
 * stays legible on the wash. No dot beside it — the surface IS the mark.
 */
export function attentionRowSurfaceClass(selected: boolean): string {
  return [
    'bg-[color:var(--tone-warn-soft)] hover:bg-[color:var(--tone-warn-soft)]',
    selected ? SELECTION_EDGE_CLASS : '',
    'text-[color:var(--tone-warn-on-tint)]',
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * A row that finished while nobody was looking: the faint green wash, which
 * lifts the moment the row is opened. A real turn end earns it, nothing else.
 */
export function doneRowSurfaceClass(selected: boolean): string {
  return [
    'bg-[color:var(--tone-good-faint)] hover:bg-[color:var(--tone-good-faint)]',
    selected ? SELECTION_EDGE_CLASS : '',
    'text-[color:var(--tone-good-on-tint)]',
  ]
    .filter(Boolean)
    .join(' ')
}
