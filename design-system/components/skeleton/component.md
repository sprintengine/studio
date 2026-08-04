# Skeleton

The placeholder for content whose **shape is already known**: a ghost block
where a title, a row, or a paragraph line will land, so the reveal of real
content is a fill-in, not a reflow. Extracted from the source product's
`Skeleton` (`src/renderer/src/components/ui/Skeleton.tsx`) and the
terminal-replay composition beside it (`TerminalReplaySkeleton.tsx`).

Use a skeleton when the incoming layout is predictable — a list of rows, a
detail pane's fields. When the panel has no shape to promise, use the loading
overlay (see `spinner`) instead: skeleton rows for content that might be empty
is a promise the data may not keep. And a skeleton is for **loading only** —
never a placeholder for empty, error, or permission-denied, each of which is a
designed state of its own. A failed dependency must never render as ghost
blocks that imply data is coming.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Block | `.ds-skeleton` | yes — one ghost block; size comes from the consumer |

That is the whole component. Rows, cards, and columns of blocks are the
consumer's composition, sized to the real content's dimensions — a skeleton
that does not match what replaces it causes the reflow it exists to prevent.

The block is a neutral fill (`bg.active`) at `radius.chip`, with a shimmer
sweep whose highlight is `border.subtle` — an ink-tinted wash in light mode
and a paper-tinted one in dark, from the same token.

## Variants

- Default — shimmering. The sweep says *alive right now*: the app is working
  on this region.
- `ds-skeleton--static` — no shimmer. For the moments when many blocks mount
  at once (the terminal-replay restore mimics dense scrollback with dozens of
  ghost lines): one animation per block at mount time is compositor cost at
  the exact moment the app is busiest, and quiet ghost blocks still read as
  "content is coming". A region uses one variant, not a mix.

The **terminal replay skeleton** is a composition of the static variant, not
its own component: fixed-width ghost lines (stable across re-renders — no
randomness) shaped like prompt blocks and output fragments, laid over the
terminal ground, `pointer-events: none`, with one `role="status"` sentence
("Restoring terminal history…") for readers.

## States

| State | Treatment |
|---|---|
| Loading | Blocks visible; shimmer if the default variant |
| Reduced motion | The sweep does not render at all — the static fill is the whole treatment |
| Resolved | Blocks are replaced by content of the same dimensions. No fade-out choreography |

## Usage

- Match the real content's geometry: a 13px body line gets a body-height
  block at partial width, a 6px dot gets a dot. Uniform full-width slabs read
  as a wireframe, not a promise.
- Vary ghost line widths the way real content varies, and **fix** the widths —
  a re-render must not reshuffle the placeholder.
- Skeleton the first screenful only. Content below the fold loads behind the
  scroll; ghosting it buys nothing.
- Never put a skeleton behind a spinner, or beside one. One loading idiom per
  region — the same rule as status idioms.
- The blocks are `aria-hidden`, always. A region announces itself once with a
  single `role="status"` phrase, not once per block.

## Accessibility

- Every block is `aria-hidden="true"`: ghost geometry is noise to a screen
  reader. The loading fact is carried by one visually-hidden `role="status"`
  sentence per region — polite, not assertive; loading is not an alert.
- The shimmer honors `prefers-reduced-motion: reduce` by not existing: the
  static fill carries the meaning, so motion is never the sole signal.
- Skeletons take no focus and sit in no tab order. If the region's real
  content will be focusable, focus arrives with the content, never with the
  ghost.

## Known drift

Shipped shimmer colors come from per-theme `--skeleton-shimmer-low/high`
variables declared in `assets/index.css`, outside the `--sem-*` set — 17 of
the app's 19 themes tune them by hand. This entry expresses the same design
through the semantic ramp (`bg.active` fill, `border.subtle` highlight);
folding the shimmer pair into the token source is the outstanding
reconciliation. The shipped sweep period (1400ms) is a loop, not a
transition, so it takes no `motion.duration.*` token — those govern the three
eased motions, and a skeleton is none of them.
