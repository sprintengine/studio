// A pull request as the app shows it on a conversation (backlog epic
// pull-request-marks, decisions 1–6). Three states and nothing else: a draft is
// an OPEN pull request with `isDraft` set, never a fourth state, and there is
// no "unknown" — the app draws a pull request only when it definitely has one.
//
// State comes from GitHub (through `gh`) or stays as last read. It is NEVER
// inferred from git ancestry: a rebase, a force push or a squash merge leaves
// no ancestor of the branch tip on main, so `merge-base --is-ancestor` would
// call a landed pull request open for ever (decision 8c).

export type PullRequestState = 'open' | 'merged' | 'closed'

export type BranchPullRequest = {
  /** Canonical URL, as `parsePullRequestUrl` (src/shared/review/pr-url.ts) would normalise it. */
  url: string
  number: number
  title: string
  state: PullRequestState
  /** A draft is still `open`; this only changes the tooltip's word. */
  isDraft: boolean
  /** When GitHub says it was opened, ms epoch. */
  openedAt: number
  /** When `state` was last read from GitHub, ms epoch. */
  stateAt: number
  /** The session whose hooks captured the creation; absent for a branch lookup. */
  openedBySessionId?: string
}

/**
 * The tone a pull request's state inks with (decision 2): open takes the
 * accent because it is the one you can still act on; merged takes the violet
 * the run glyph already wears once a branch lands; closed takes the danger
 * red GitHub itself uses for a pull request that ended without landing.
 * Shape carries the state — the tone only agrees with it.
 */
export type PullRequestTone = 'accent' | 'merged' | 'error'

export function pullRequestTone(state: PullRequestState): PullRequestTone {
  if (state === 'merged') return 'merged'
  if (state === 'closed') return 'error'
  return 'accent'
}

/** The CSS custom property each tone resolves to, for callers that ink by class. */
export const PULL_REQUEST_TONE_VAR: Record<PullRequestTone, string> = {
  accent: 'var(--accent-primary)',
  merged: 'var(--tone-merged)',
  error: 'var(--tone-error)',
}

/** The word a tooltip or a spoken label uses for the state. */
export function pullRequestStateLabel(pr: Pick<BranchPullRequest, 'state' | 'isDraft'>): string {
  if (pr.state === 'merged') return 'merged'
  if (pr.state === 'closed') return 'closed'
  return pr.isDraft ? 'open, draft' : 'open'
}

function newestFirst(a: BranchPullRequest, b: BranchPullRequest): number {
  return b.openedAt - a.openedAt || b.number - a.number
}

/**
 * The one pull request a conversation wears (decision 5): the most recent one
 * that is still open, or the newest of all once every one has landed or
 * closed. `null` when there are none — and then nothing is drawn.
 */
export function primaryPullRequest(list: readonly BranchPullRequest[]): BranchPullRequest | null {
  if (list.length === 0) return null
  const sorted = [...list].sort(newestFirst)
  return sorted.find((pr) => pr.state === 'open') ?? sorted[0] ?? null
}

/**
 * The menu's groups (decision 6): open, merged, closed, newest first within
 * each. Callers omit empty groups.
 */
export function groupPullRequests(list: readonly BranchPullRequest[]): {
  open: BranchPullRequest[]
  merged: BranchPullRequest[]
  closed: BranchPullRequest[]
} {
  const sorted = [...list].sort(newestFirst)
  return {
    open: sorted.filter((pr) => pr.state === 'open'),
    merged: sorted.filter((pr) => pr.state === 'merged'),
    closed: sorted.filter((pr) => pr.state === 'closed'),
  }
}

/** Every pull request other than the primary, newest first — the tooltip's "Earlier:" lines. */
export function earlierPullRequests(list: readonly BranchPullRequest[]): BranchPullRequest[] {
  const primary = primaryPullRequest(list)
  return [...list].sort(newestFirst).filter((pr) => pr !== primary)
}
