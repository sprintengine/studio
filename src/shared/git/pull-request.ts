// A pull request as the app shows it on a conversation (backlog epic
// pull-request-marks, decisions 1–6). Three states and nothing else: a draft is
// an OPEN pull request with `isDraft` set, never a fourth state, and there is
// no "unknown" — the app draws a pull request only when it definitely has one.
//
// State comes from GitHub (through `gh`) or stays as last read. It is NEVER
// inferred from git ancestry: a rebase, a force push or a squash merge leaves
// no ancestor of the branch tip on main, so `merge-base --is-ancestor` would
// call a landed pull request open for ever (decision 8c).

import { canonicalPullRequestUrl, parsePullRequestUrl } from '../review/pr-url'
import { canonicalRepositoryKey } from '../repository-identity'

export type PullRequestState = 'open' | 'merged' | 'closed'

export type BranchPullRequest = {
  /** Canonical URL, as `parsePullRequestUrl` (src/shared/review/pr-url.ts) would normalise it. */
  url: string
  /**
   * The repository the pull request is IN — `host/owner/name`, the key every
   * clone of it shares (`canonicalRepositoryKey`). Not always the repository the
   * conversation sits in: an agent that runs `cd ../website && gh pr create`
   * opens one somewhere else entirely, and the URL is what says where
   * (decision 10).
   */
  repoKey: string
  /** The repository's short name, for the rows and tooltips that must say which repo. */
  repoName: string
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
  // "closed" alone reads as resolved; the mockup's wording says the work did
  // NOT land, which is the fact the red cross is drawing.
  if (pr.state === 'closed') return 'closed without merging'
  return pr.isDraft ? 'open, a draft' : 'open'
}

/**
 * The repository a pull request URL names. Built through the one URL parser and
 * the one repository canonicaliser, so a captured pull request keys exactly the
 * way a local clone of that repository does and the two join up.
 */
export function pullRequestRepository(url: string): { repoKey: string; repoName: string } | null {
  const parsed = parsePullRequestUrl(url)
  if (!parsed || 'unsupported' in parsed) return null
  const repoKey = canonicalRepositoryKey(`https://${parsed.host}/${parsed.owner}/${parsed.repo}`)
  if (!repoKey) return null
  const segments = repoKey.split('/').filter((segment) => segment.length > 0)
  return { repoKey, repoName: segments[segments.length - 1] ?? parsed.repo }
}

/** The canonical URL for a pull request URL, or null when it is not one. */
export function canonicalPullRequestUrlOf(url: string): string | null {
  const parsed = parsePullRequestUrl(url)
  return !parsed || 'unsupported' in parsed ? null : canonicalPullRequestUrl(parsed)
}

/**
 * The list a conversation wears: everything on its own repo and branch, plus
 * everything it opened itself in any repository (decision 10), de-duplicated by
 * URL and newest first. The same pull request reached both ways is one row —
 * the reading that knows more wins: the newer state, and the entry that
 * remembers which session opened it.
 */
export function unionPullRequests(...lists: readonly (readonly BranchPullRequest[])[]): BranchPullRequest[] {
  const byUrl = new Map<string, BranchPullRequest>()
  for (const list of lists) {
    for (const entry of list) {
      const previous = byUrl.get(entry.url)
      if (!previous) {
        byUrl.set(entry.url, entry)
        continue
      }
      const winner = entry.stateAt > previous.stateAt ? entry : previous
      const other = winner === entry ? previous : entry
      byUrl.set(
        entry.url,
        winner.openedBySessionId || !other.openedBySessionId
          ? winner
          : { ...winner, openedBySessionId: other.openedBySessionId },
      )
    }
  }
  return [...byUrl.values()].sort(newestFirst)
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
