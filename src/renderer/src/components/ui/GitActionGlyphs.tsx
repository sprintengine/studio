// The Commit window's and the diff window's action vocabulary: *what will this
// toolbar button do*. Eighteen concepts, drawn once here and mirrored
// framework-neutral in `design-system/glyphs/` (rollback, move-to-changelist,
// stash, group-by, expand-all, collapse-all, next-difference,
// previous-difference, show-diff, side-by-side, unified, gear, open-in-editor,
// write-commit-message, new-changelist, delete-changelist, edit-changelist,
// create-patch) — see design-system/components/glyphs/component.md → "Git and
// diff actions". Eighteen concepts, seventeen drawings: the two difference
// steps are one shape mirrored.
//
// 16-grid, `currentColor`, `fill="none"`, frame 1.3 / line work 1.4, legible at
// `--sem-icon-size-sm`. Every glyph is `aria-hidden`: an action glyph never
// speaks for itself, the icon-only button that hosts it carries the
// `aria-label` and the tooltip, and it never grows to fill its own hit area —
// `IconButton` pads out around it.
//
// Three of these exist only because the nearest lookalike answers a different
// question, and reaching for it would put two meanings on one shape:
//
//   RollbackGlyph  vs `ResetIcon` — reset restores a DEFAULT (a rebound
//                  shortcut, a changed setting) on the 24-grid settings rail;
//                  rollback throws a person's work away. Same arrow family,
//                  opposite consequence, so they are not one glyph.
//   GearGlyph      vs `GeneralSettingsIcon` (sliders, 24-grid rail) and the
//                  `config` FILE KIND in `FileTypeGlyph` (an identity mark for
//                  a dotfile). Neither is a toolbar action; this is a real
//                  toothed gear so the toolbar's "settings" reads as a verb.
//   Next/Previous  vs `ChevronDownIcon` — a bare chevron says DISCLOSURE. Hunk
//   DifferenceGlyph stepping is travel, so the arrow lands on a rule: the hunk
//                  boundary it stops at. One drawing, mirrored for the other
//                  direction, the way the chevron is rotated rather than
//                  twinned.
//   ShowDiffGlyph  vs `NextDifferenceGlyph` — OPEN the comparison, not move
//                  within it. Both surfaces of the Commit window reached for the
//                  hunk-stepper until 2026-09-09, which put one mark on two
//                  verbs across two windows.
//
// `StashGlyph` is the opposite move: the drawer was already drawn inline in
// `GitPanel.tsx` for the Stashes view, and putting changes away is one concept
// whether it is a view or a verb — so it is EXTRACTED here, not redrawn, and
// the panel imports it.

import React from 'react'

type GlyphProps = {
  className?: string
}

/** Discard a file's changes: the undo arrow doubling back on itself. */
export function RollbackGlyph({ className = 'icon-sm' }: GlyphProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M5.25 6H9.5a2.75 2.75 0 0 1 0 5.5H4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path
        d="M7.5 3.75 5.25 6l2.25 2.25"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Move the checked files into another changelist: two opposed arrows. */
export function MoveToChangelistGlyph({ className = 'icon-sm' }: GlyphProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M2.5 5.25h9M9 2.75l2.5 2.5L9 7.75"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13.5 10.75h-9M7 8.25l-2.5 2.5L7 13.25"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Stash uses a drawer mark, lifted out of `GitPanel.tsx` so the
 *  Stashes view strip and the Commit toolbar wear the same mark. */
export function StashGlyph({ className = 'icon-sm' }: GlyphProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M1.9 5.6h12.2v6.4a1.1 1.1 0 0 1-1.1 1.1H3a1.1 1.1 0 0 1-1.1-1.1z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M2.6 2.9h10.8a.7.7 0 0 1 .7.7v2H1.9v-2a.7.7 0 0 1 .7-.7z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M6.5 8.75h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

/** Grouping options for the changes list: the target. */
export function GroupByGlyph({ className = 'icon-sm' }: GlyphProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <circle cx="8" cy="8" r="5.25" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** Expand every group: two chevrons apart. */
export function ExpandAllGlyph({ className = 'icon-sm' }: GlyphProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M4.5 5.75 8 2.25l3.5 3.5M4.5 10.25 8 13.75l3.5-3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Collapse every group: the same two chevrons, together. */
export function CollapseAllGlyph({ className = 'icon-sm' }: GlyphProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M4.5 2.25 8 5.75l3.5-3.5M4.5 13.75 8 10.25l3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// The one difference-stepping drawing: an arrow travelling toward a rule — the
// hunk boundary it lands on. `PreviousDifferenceGlyph` is this drawing mirrored
// about y = 8, not a second shape.
const DIFFERENCE_ARROW = 'M8 3v6.75M4.9 6.6 8 9.75l3.1-3.15'
const DIFFERENCE_RULE = 'M3.5 12.9h9'

function DifferenceStep({ className, flipped }: { className: string; flipped: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      {/* A vertical mirror about the grid's own midline, so the two directions
          cannot drift apart the way two hand-drawn twins would. */}
      <g transform={flipped ? 'matrix(1 0 0 -1 0 16)' : undefined}>
        <path
          d={DIFFERENCE_ARROW}
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d={DIFFERENCE_RULE} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </g>
    </svg>
  )
}

/** Step to the next hunk. */
export function NextDifferenceGlyph({ className = 'icon-sm' }: GlyphProps): JSX.Element {
  return <DifferenceStep className={className} flipped={false} />
}

/** Step to the previous hunk — the same drawing, mirrored. */
export function PreviousDifferenceGlyph({ className = 'icon-sm' }: GlyphProps): JSX.Element {
  return <DifferenceStep className={className} flipped />
}

/**
 * Show the diff of this file — the Commit window's toolbar item and its row
 * menu's.
 *
 * Two opposed arrows, one running right over a rule and one running left under
 * it: two versions, read against each other. It exists because both surfaces
 * were reaching for `NextDifferenceGlyph`, which the DIFF WINDOW spends on
 * "step to the next hunk" — one shape answering "open the comparison" in one
 * window and "move within the comparison" in the other, which is how a person
 * learns that a mark means nothing in particular.
 */
export function ShowDiffGlyph({ className = 'icon-sm' }: GlyphProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M2.25 5.25h8.5M8 2.75l2.75 2.5L8 7.75M13.75 10.75h-8.5M8 8.25l-2.75 2.5L8 13.25"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Diff layout: two panes. A frame split by one vertical line. */
export function SideBySideGlyph({ className = 'icon-sm' }: GlyphProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="1.75" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 2.5v11" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

/** Diff layout: one pane. The same frame, unsplit — the pair is a two-state
 *  toggle, so the divider's presence or absence IS the difference. */
export function UnifiedGlyph({ className = 'icon-sm' }: GlyphProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="1.75" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

/**
 * Open the file this diff is about in an editor. The pencil on the page — the
 * one mark in this family that leaves the diff rather than acting on it, which
 * is why it is a pencil and not another frame: every other glyph here rearranges
 * what you are looking at, and this one hands the file to something that can
 * change it.
 */
export function OpenInEditorGlyph({ className = 'icon-sm' }: GlyphProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M2.75 13.25 3.5 10 11 2.5l2.5 2.5L6 12.5l-3.25.75Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M9.5 4 12 6.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** Settings on a toolbar: a real toothed gear, six teeth so it still reads at
 *  16 px. Not the sliders of `GeneralSettingsIcon`, not the `config` file kind. */
export function GearGlyph({ className = 'icon-sm' }: GlyphProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M6.64 1.9 9.36 1.9 9.46 3.69 11 4.58 12.6 3.77 13.96 6.13 12.46 7.11 12.46 8.89 13.96 9.87 12.6 12.23 11 11.42 9.46 12.31 9.36 14.1 6.64 14.1 6.54 12.31 5 11.42 3.4 12.23 2.04 9.87 3.54 8.89 3.54 7.11 2.04 6.13 3.4 3.77 5 4.58 6.54 3.69Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

/**
 * Write the commit message. Three lines of a message with a spark beside them:
 * the mark says *text, composed for you*, which is what the action does once
 * the composer can do it. Not `OpenInEditorGlyph`'s pencil — a pencil says a
 * person will type it — and not `GearGlyph`, which is a setting rather than a
 * verb. Drawn with line work only, like the rest of the family: the sparkle is
 * a crossed star, not a filled shape.
 */
export function WriteCommitMessageGlyph({ className = 'icon-sm' }: GlyphProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M2.25 4.25h7.5M2.25 7.5h5.5M2.25 10.75h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M12.4 7.9v5.2M9.8 10.5h5.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M10.9 9 13.9 12M13.9 9 10.9 12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

// --- Changelists and patches (git-commit-window T6) ---------------------------
// Four more concepts, and each is here for the same reason the eleven above
// are: the nearest lookalike in the product answers a different question.
//
//   New / Delete changelist — a plus and a minus INSIDE the changelist's own
//   two-arrow frame would be four marks in 16px and read as nothing. The list
//   itself is the noun the menu row already names, so these are the bare
//   operators, drawn as the same round-capped line work as the family.
//   `FolderPlusIcon` is a 24-grid folder and says "a new folder"; a changelist
//   is not a folder.
//
//   EditChangelistGlyph — a bare pencil. `OpenInEditorGlyph` is the pencil ON A
//   PAGE and means "hand this file to an editor"; renaming a list touches no
//   file, so it drops the page and keeps only the tool.
//
//   CreatePatchGlyph — a page with a diff's two marks on it: a plus line over a
//   minus line. Not `WriteCommitMessageGlyph`'s message lines (that is prose
//   being composed) and not a frame (every frame in this family is a LAYOUT).

/** New changelist: the plus, at the family's line weight. */
export function NewChangelistGlyph({ className = 'icon-sm' }: GlyphProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M8 3.25v9.5M3.25 8h9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

/** Delete changelist: the minus. The pair is one mark and its absence, the way
 *  `ExpandAllGlyph` and `CollapseAllGlyph` are one drawing twice. */
export function DeleteChangelistGlyph({ className = 'icon-sm' }: GlyphProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M3.25 8h9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

/** Edit changelist: the bare pencil — the tool without the page, because a
 *  rename touches the list and not a file. */
export function EditChangelistGlyph({ className = 'icon-sm' }: GlyphProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M3.25 12.75 3.9 10.1 10.4 3.6a1.2 1.2 0 0 1 1.7 0l.3.3a1.2 1.2 0 0 1 0 1.7l-6.5 6.5-2.65.65Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M9.3 4.7 11.3 6.7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** Create a patch: the page carrying a diff's two lines, one added, one taken
 *  away. A patch is a file OF a difference, so the mark is both. */
export function CreatePatchGlyph({ className = 'icon-sm' }: GlyphProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M3.75 2.25h5l3.5 3.5v8a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M8.75 2.4v3.2h3.2" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M6.9 9.1h2.2M8 8v2.2M6.9 12.1h2.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}
