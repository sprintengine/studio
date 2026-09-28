# Spinner

The "working on this, and it will finish" mark: a faint track ring with a
90° accent arc rotating through it, at icon scale, beside the thing that is
working. It is for a bounded wait (a button's action, a task row's run). An
agent or process that runs for as long as it runs wears the working dots
(`liveness`) instead.
Extracted from the source product's `Spinner`
(`src/renderer/src/components/ui/Spinner.tsx`); the same drawing serves the
lifecycle glyph's in-progress state, so a spinning task row and a spinning
button say "live" with the same shape.

This entry also owns the **loading overlay**
(`src/renderer/src/components/ui/LoadingOverlay.tsx`) — the centered "we're
working on it" state for a panel that has no shape to skeleton. One entry, not
two, because they are the same question at two scopes, and because the overlay
**deliberately does not contain the spinner**: judgment call, documented
below.

Choosing among the three loading idioms:

- **Spinner** — a *specific, named* process is live: this task, this sync,
  this button's submit.
- **Skeleton** — the panel's incoming *shape* is known; ghost it (see
  `skeleton`).
- **Loading overlay** — the panel has no shape to promise yet: the working
  dots and one sentence, centered.

The overlay does not use the spinner because the rotating arc means *a live
process the user can point to*, drawn at icon scale beside that process. A
panel that is merely fetching has no such process to name, and a large
centered rotating accent mark is the generic-dashboard default this system
exists to avoid. The overlay shows the **working dots** instead: the status
mark (`status-dot`, a live good tone) that every other "working right now"
surface already shows, at their own 14px width. That does spend the accent —
an honest cost, since fetching is live work — but on three small dots the
person already reads as "working", not on a panel-sized mark. Until
2026-09-28 the overlay drew a pulsing 8px `status.good` dot precisely to keep
the accent unspent; the product draws no status dots now (owner ruling
2026-09-28), because a pulsing disc had no shape to tell working from
waiting.

## Anatomy

Spinner:

| Part | Class | Required |
|---|---|---|
| Mark | `.ds-spinner` | yes — an inline SVG: track circle at 22% stroke opacity, quarter arc on top |

Loading overlay:

| Part | Class | Required |
|---|---|---|
| Region | `.ds-loading-overlay` | yes — fills and centers within the panel |
| Body | `.ds-loading-overlay-body` | yes — mark + label cluster, `space.lg` gap |
| Mark | `.ds-status-dot.ds-status-dot--working` | yes — the working dots from `status-dot`, `aria-hidden` |
| Label | `.ds-loading-overlay-label` | yes — one sentence, `font.size.meta` in `text.muted` |

## Variants

- Spinner default — `icon.size.sm`, `accent.primary` ink.
- `ds-spinner--md` — `icon.size.md`, for `size.control.md` contexts. Nothing
  larger: a spinner bigger than an icon is a panel state, and panel states are
  the overlay's job.
- The overlay has no variants. One mark, one sentence, centered.

## States

| State | Treatment |
|---|---|
| Live | The arc rotates (spinner) / the working dots cycle (overlay), continuous |
| Reduced motion | Spinner freezes to its at-rest arc; the working dots stand still, all three of them. The shape and the label still say "working" |
| Done | The mark unmounts. No completion flourish |

A frozen spinner still reads: track + arc is the in-progress shape whether or
not it moves, which is what makes the reduced-motion state honest rather than
broken.

## Usage

- **A spinner means live, now.** Never ambient decoration, never "the app is
  generally busy", and removed the moment the process ends. If it might spin
  for less than ~300ms, debounce its appearance — a flash-spinner is noise.
- At most one motion treatment animating per view — the ceiling from
  `foundations/principles.md`. A list where every row could spin shows the
  arc on genuinely running rows only; three simultaneous spinners is a
  hierarchy failure, not a busy app.
- The spinner sits beside its subject at icon scale, sharing the row's gap —
  never floated over content, never centered in a panel (that is the
  overlay).
- The overlay's sentence names the work ("Loading sessions…"), sentence case,
  no product name, no reassurance prose. One line; if there is more to say,
  the panel has content and should show it.
- Motion is never the sole signal: adjacent text (a "Running" label, the
  overlay's sentence) or an accessible name always carries the state in
  words.

## Accessibility

- A spinner beside text that already names the state is decorative:
  `aria-hidden="true"`, no role. A spinner standing alone carries
  `role="img"` and an `aria-label` naming the work — never an unlabeled
  moving mark.
- The overlay region is `role="status"` with `aria-live="polite"`: it
  announces once, and loading is never assertive. The working dots inside it
  are `aria-hidden` — the sentence is the announcement.
- Both honor `prefers-reduced-motion: reduce` in CSS, not in script, so the
  preference works even where no framework mounted.
- The rotation and pulse are opacity/transform-only animations — cheap to
  composite, no layout thrash while real work competes for the main thread.

## Known drift

The spinner's rotation period (900ms) and the working dots' cycle (1200ms)
are shipped values with no token: they are loops, not transitions, so the
three `motion.duration.*` steps do not apply.
