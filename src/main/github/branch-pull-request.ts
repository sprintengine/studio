// The missing primitive: the pull requests on a branch, and a pull request's
// state (epic `pull-request-marks`, decisions 3, 8a, 8c, 9). Nothing else in the
// app could resolve a branch to a pull request number — the whole review system
// is URL-keyed — and nothing read `isDraft` or `mergedAt` at all.
//
// THROUGH `gh`, NEVER REST (decision 11). One runner, `main/github/gh.ts`: gh's
// own credential store is the single auth source, and GitHub Enterprise Server
// comes free because the checkout's remote decides which host is asked.
//
// TWO DIFFERENT ANSWERS. "This branch has no pull request" and "I could not ask"
// are not the same fact and this module never conflates them: a read either
// SETTLES (and its list, empty or not, is the truth) or it does not (and every
// caller must leave what it already knew alone). `repository-identity.ts` set
// this precedent for repository remotes; a mark that flickered off because a
// laptop was offline for one probe would be worse than no mark at all.
//
// NO GIT-ANCESTRY FALLBACK, EVER (decision 8c). It is tempting to answer "is it
// merged?" with `git merge-base --is-ancestor`, and it is wrong: a rebase, a
// force push or a squash merge leaves none of the branch's commits on main, so
// the check would call a landed pull request open for ever. State comes from
// GitHub or stays as last read. That is the whole rule.
//
// FORKS. `gh pr list --head` matches on BRANCH NAME only — it is not
// owner-qualified — so a pull request opened from a fork whose branch shares the
// name is indistinguishable from one opened on the origin repository. We do not
// attempt an owner-qualified head (it would need the fork's owner, which the
// local checkout does not know for a branch it did not push). For the sidebar's
// purpose — "this conversation's branch has these pull requests" — the branch
// name is the key the person is thinking in.

import { pullRequestRepository, type BranchPullRequest, type PullRequestState } from '../../shared/git/pull-request'
import { canonicalPullRequestUrl, parsePullRequestUrl } from '../../shared/review/pr-url'
import { isRecord } from '../../shared/records'
import { sharedGhRunner, type GhRunner } from './gh'

/** Why a read could not be made. Never a statement about the pull requests themselves. */
export type PullRequestReadFailure =
  /** The `gh` binary is not installed (the runner's `found: false`). */
  | 'gh-missing'
  /** `gh` ran and failed: not authenticated, no remote, rate limited, offline. */
  | 'gh-failed'
  /** `gh` answered with something that is not the JSON we asked for. */
  | 'bad-output'
  /** The question itself was unaskable: an empty/flag-shaped branch, an unparseable URL. */
  | 'bad-request'
  /** `gh` did not answer inside {@link GH_READ_TIMEOUT_MS}. */
  | 'timeout'

export type BranchPullRequestsRead =
  | { settled: true; pullRequests: BranchPullRequest[] }
  | { settled: false; reason: PullRequestReadFailure }

/**
 * What a state re-read learned. `stateAt` is the moment GitHub was asked, and
 * `headRefName` is the branch the pull request is FROM — the only way a pull
 * request captured from a hook (which knows a URL and nothing else) ever learns
 * which branch it belongs to (decision 10). Null when GitHub did not say.
 */
export type PullRequestStateRead =
  | { settled: true; state: PullRequestState; isDraft: boolean; stateAt: number; headRefName: string | null }
  | { settled: false; reason: PullRequestReadFailure }

/**
 * How long one `gh` call may take before the read is "could not ask". The
 * subprocess is not killed — we simply stop waiting on it, so a hover never
 * hangs behind a laptop that is off the network. Generous, because a cold `gh`
 * on a large repository is genuinely slow and a needless unsettled answer costs
 * a retry.
 */
export const GH_READ_TIMEOUT_MS = 15_000

export type BranchPullRequestDeps = {
  gh?: GhRunner
  now?: () => number
  timeoutMs?: number
}

/** The fields the list read asks `gh` for — one place, so the parser cannot drift from the query. */
const LIST_FIELDS = 'number,url,title,state,isDraft,createdAt,mergedAt,closedAt'
const VIEW_FIELDS = 'state,isDraft,mergedAt,closedAt,headRefName'

/**
 * Every pull request whose head is `branch`, as GitHub knows them — open, merged
 * and closed alike (decision 6 keeps the earlier ones; nothing is dropped).
 * Run inside `gitRoot`, so the remote of THAT checkout picks the host and repo:
 * a linked worktree answers for its own repository without being told which.
 */
export async function listBranchPullRequests(
  input: { gitRoot: string; branch: string },
  deps: BranchPullRequestDeps = {},
): Promise<BranchPullRequestsRead> {
  const gitRoot = input.gitRoot?.trim()
  const branch = input.branch?.trim()
  // A leading dash would be read by `gh` as a flag, and an empty branch would
  // list the whole repository's pull requests. Neither is a question we asked.
  if (!gitRoot || !branch || branch.startsWith('-')) return { settled: false, reason: 'bad-request' }

  const result = await runGh(
    ['pr', 'list', '--head', branch, '--state', 'all', '--json', LIST_FIELDS],
    { cwd: gitRoot },
    deps,
  )
  if (!result.ok) return { settled: false, reason: result.reason }

  const rows = parseJson(result.stdout)
  if (!Array.isArray(rows)) return { settled: false, reason: 'bad-output' }

  const now = (deps.now ?? Date.now)()
  const pullRequests: BranchPullRequest[] = []
  for (const row of rows) {
    const pullRequest = toBranchPullRequest(row, now)
    // A row we cannot key (no parseable URL) or cannot state (an unknown state
    // word) is skipped rather than guessed at. The read still settled: the rows
    // we DID understand are the truth about this branch.
    if (pullRequest) pullRequests.push(pullRequest)
  }
  pullRequests.sort((a, b) => b.openedAt - a.openedAt || b.number - a.number)
  return { settled: true, pullRequests }
}

/**
 * One pull request's state, by URL. The refresh path: the watch calls it on its
 * backoff, hover calls it when the reading has gone stale. Unsettled leaves the
 * caller's last reading standing (decision 3).
 */
export async function readPullRequestState(
  url: string,
  deps: BranchPullRequestDeps = {},
): Promise<PullRequestStateRead> {
  const parsed = parsePullRequestUrl(url?.trim() ?? '')
  // Not a pull request URL we can name — including a Bitbucket one, which `gh`
  // could not answer for either. Unsettled, so nothing recorded is overwritten.
  if (!parsed || 'unsupported' in parsed) return { settled: false, reason: 'bad-request' }

  const result = await runGh(['pr', 'view', canonicalPullRequestUrl(parsed), '--json', VIEW_FIELDS], {}, deps)
  if (!result.ok) return { settled: false, reason: result.reason }

  const json = parseJson(result.stdout)
  if (!isRecord(json)) return { settled: false, reason: 'bad-output' }
  const state = readState(json)
  if (!state) return { settled: false, reason: 'bad-output' }
  return {
    settled: true,
    state,
    isDraft: json.isDraft === true && state === 'open',
    stateAt: (deps.now ?? Date.now)(),
    headRefName: typeof json.headRefName === 'string' && json.headRefName.length > 0 ? json.headRefName : null,
  }
}

type GhOutcome = { ok: true; stdout: string } | { ok: false; reason: PullRequestReadFailure }

async function runGh(args: string[], options: { cwd?: string }, deps: BranchPullRequestDeps): Promise<GhOutcome> {
  const gh = deps.gh ?? sharedGhRunner()
  const timeoutMs = deps.timeoutMs ?? GH_READ_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  const TIMED_OUT = Symbol('timed-out')
  try {
    const raced = await Promise.race([
      gh.run(args, options),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs)
        timer.unref?.()
      }),
    ])
    if (raced === TIMED_OUT) return { ok: false, reason: 'timeout' }
    if (!raced.found) return { ok: false, reason: 'gh-missing' }
    // `gh pr list` exits 0 with `[]` for a branch with no pull requests, so a
    // non-zero exit is always a failure to ask — never "there are none".
    if (raced.code !== 0) return { ok: false, reason: 'gh-failed' }
    return { ok: true, stdout: raced.stdout }
  } catch {
    // The runner does not throw, but a caller-supplied one might: an exception
    // is a read that did not happen, not an empty list.
    return { ok: false, reason: 'gh-failed' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    return undefined
  }
}

/**
 * `gh`'s row → the app's shape. `state` is GitHub's own word; a draft is an OPEN
 * pull request with `isDraft` set and never a fourth state (decision 1).
 * `mergedAt` wins over the state word: a merged pull request is closed too, and
 * some GitHub payloads say so in that order.
 */
function toBranchPullRequest(row: unknown, now: number): BranchPullRequest | null {
  if (!isRecord(row)) return null
  const parsed = typeof row.url === 'string' ? parsePullRequestUrl(row.url) : null
  if (!parsed || 'unsupported' in parsed) return null
  const state = readState(row)
  if (!state) return null
  const number = typeof row.number === 'number' && Number.isInteger(row.number) && row.number > 0 ? row.number : parsed.number
  const repository = pullRequestRepository(row.url as string)
  if (!repository) return null
  return {
    // GHES hosts pass through untouched: the canonical form only strips the
    // paste's incidental cruft, it never rewrites the host.
    url: canonicalPullRequestUrl(parsed),
    // The repository the pull request is in, keyed the way every clone of it is.
    repoKey: repository.repoKey,
    repoName: repository.repoName,
    number,
    title: typeof row.title === 'string' ? row.title : '',
    state,
    isDraft: row.isDraft === true && state === 'open',
    openedAt: parseTimestamp(row.createdAt) ?? 0,
    stateAt: now,
  }
}

function readState(row: Record<string, unknown>): PullRequestState | null {
  if (parseTimestamp(row.mergedAt) !== null) return 'merged'
  const raw = typeof row.state === 'string' ? row.state.toUpperCase() : ''
  if (raw === 'MERGED') return 'merged'
  if (raw === 'CLOSED') return 'closed'
  if (raw === 'OPEN') return 'open'
  // A state word we do not recognise is not a state we may write down.
  return null
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}
