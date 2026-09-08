// Canonical review-progress presentation. Node-free single source for the
// review rail's per-state tone + dot label and the surface bar's status chip,
// which previously each inlined the same draft/in-progress/posted → tone +
// "Posted"/"In progress" wording. `ReviewStateTone` is the narrow subset of
// tones the review states use; it is assignable to the renderer ui `Tone` union
// without this shared module importing renderer code.

export type ReviewProgressState = 'draft' | 'in-progress' | 'posted'

type ReviewStateTone = 'neutral' | 'accent' | 'good'

export interface ReviewStatePresentation {
  tone: ReviewStateTone
  /** Short status word for the surface-bar chip. */
  label: string
  /** Fuller accessible label for the rail's status dot. */
  dotLabel: string
}

export const REVIEW_STATE_PRESENTATION: Record<ReviewProgressState, ReviewStatePresentation> = {
  draft: { tone: 'neutral', label: 'Draft', dotLabel: 'Draft — no walkthrough yet' },
  'in-progress': { tone: 'accent', label: 'In progress', dotLabel: 'In progress' },
  posted: { tone: 'good', label: 'Posted', dotLabel: 'Posted to the pull request' },
}
