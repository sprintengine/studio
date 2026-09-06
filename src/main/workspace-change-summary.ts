import { readBranchSpan, scopeOfSpan, type BranchSpan } from './git-branch-span'
import { getGitRowSummary } from './git-status'
import type { WorkspaceChangeSummary } from '../shared/electron-api'

/**
 * What a workspace's row reports as changed
 * (the-diff-an-agent-made / branch-scoped-row-diff).
 *
 * The reading is the branch the agent's checkout is on:
 * `merge-base(HEAD, <trunk>) → working tree`. Whatever the person already had
 * committed on the trunk sits on both sides of that base and never enters the
 * number, and — the property the checkpoint model could not have — a pull, a
 * merge or a commit landing under the agent moves HEAD and the base together, so
 * ordinary repo movement is invisible here by construction.
 *
 * `scope` is the honesty contract, not a debug field. It says how much the
 * caller is entitled to claim, and the row's tooltip and spoken label are
 * derived from it:
 *
 * - `worktree` — a LINKED worktree, so nothing else writes into this checkout.
 *   The numbers are this chat's work.
 * - `branch`   — a shared checkout on a branch that is NOT the trunk, carrying
 *   commits the trunk does not. The numbers are the BRANCH's work, which may
 *   include commits a person or another chat made on it.
 * - `folder`   — a shared checkout with no branch work to attribute: on the
 *   trunk itself, detached, or with no trunk to compare against. All that can
 *   honestly be said is what is uncommitted.
 *
 * The rule this file exists to enforce, inherited from the reading it replaced
 * and restored after a review found it missing: **never report a confident zero
 * for a span we could not read.** The row draws nothing for zeros, so an
 * unreadable span reported as zero would silently claim "this agent changed
 * nothing" about work it merely failed to measure.
 */
export async function getWorkspaceChangeSummary(
  input: { checkoutPath: string },
  deps: { summaries?: CheckoutSummaryShare } = {}
): Promise<WorkspaceChangeSummary> {
  return (deps.summaries ?? defaultCheckoutSummaries).read(input.checkoutPath)
}

/**
 * The pure half: a span becomes a summary. Separated so the scope rule — the one
 * thing a reviewer needs to check — tests without a repo.
 */
export function summaryFromSpan(span: BranchSpan | null): WorkspaceChangeSummary {
  if (!span) {
    return { branch: null, additions: 0, deletions: 0, changedFiles: 0, scope: 'folder' }
  }
  return {
    branch: span.branch,
    additions: span.stat.additions,
    deletions: span.stat.deletions,
    changedFiles: span.stat.changedFiles,
    // The shared rule, not a local copy — the step strip renders the same span
    // and must say the same thing about it.
    scope: scopeOfSpan(span),
  }
}

/**
 * One reading for one checkout: the branch span, or the folder's own numbers
 * when the span could not be measured.
 *
 * The fallback is deliberately the FOLDER reading rather than zeros. A locked
 * index, a bare repo or a corrupt object makes `git diff <base>` fail, and the
 * quiet, unattributed folder number is the honest thing to show there — the same
 * degrade the checkpoint reading made for an unresolvable ref.
 */
async function readCheckoutSummary(checkoutPath: string): Promise<WorkspaceChangeSummary> {
  const span = await readBranchSpan(checkoutPath)
  if (span && !span.readable) {
    const folder = await getGitRowSummary(checkoutPath)
    return {
      branch: span.branch ?? folder.branch,
      additions: folder.additions,
      deletions: folder.deletions,
      changedFiles: 0,
      scope: 'folder',
    }
  }
  return summaryFromSpan(span)
}

/**
 * One read per CHECKOUT per sweep, shared by every row that resolves to it.
 *
 * This is the per-folder dedupe that `workspace-scoped-row-diff` deleted,
 * deliberately restored and re-keyed (epic decision 7). Removing it was correct
 * under the checkpoint model, where ten chats on one repo genuinely had ten
 * different answers and sharing one would have been the bug the epic existed to
 * fix. Under the branch model two chats sharing a checkout genuinely have the
 * SAME answer — that is the premise of the design — so one read serving both is
 * correct, and the alternative is ten identical `git diff` runs a minute.
 *
 * It caches the SUMMARY, not the span: a span carries the whole per-file list,
 * which nothing here reads and which would then be retained per checkout for the
 * life of the process. Expired entries are dropped on the next read rather than
 * left in the map, so what is retained is bounded by the checkouts currently
 * being polled and not by every checkout ever polled.
 *
 * A read is shared while in flight and held for `holdMs` after it settles, which
 * covers a sweep's serial tail at the poll's concurrency of four; the next sweep
 * always gets a fresh read. The hold is measured from settle rather than start on
 * purpose — a slow read on a large repo must not expire while the rows queued
 * behind it are still arriving.
 *
 * A rejected read is forgotten immediately, so a transient failure never pins an
 * error onto every row of the checkout for the hold window.
 */
export type CheckoutSummaryShare = {
  read: (checkoutPath: string) => Promise<WorkspaceChangeSummary>
}

/**
 * Forty-five seconds, up from fifteen (2026-09-05). The share is now read from
 * the network as well as the sidebar — a paired Studio's Remote band asks
 * `terminal.list` every thirty seconds, and the phone asks when it is open —
 * and a fifteen-second hold meant every one of those asks re-ran the whole
 * branch-span chain (about twenty git spawns per checkout, each spawn a
 * synchronous step on main's event loop). Forty-five keeps the sidebar's own
 * sixty-second sweep fresh, and folds every other reader in between into the
 * read that already happened.
 */
export const CHECKOUT_SUMMARY_HOLD_MS = 45_000
/**
 * How many checkouts are read at once, across every caller of the share. The
 * sidebar queued its own reads four wide; the network path fanned out to every
 * distinct checkout at once, which on a sixteen-checkout registry was sixteen
 * git chains spawning in parallel on the event loop. One queue for both.
 */
export const CHECKOUT_SUMMARY_CONCURRENCY = 4
/**
 * How long an in-flight read is shared before a newcomer starts its own. A
 * `git diff` hung on a spun-down volume must not pin every row of that checkout,
 * in every window, for the life of main — this keeps that worst case per read
 * rather than per checkout.
 */
export const CHECKOUT_SUMMARY_IN_FLIGHT_MAX_MS = 60_000

export function createCheckoutSummaryShare(
  read: (checkoutPath: string) => Promise<WorkspaceChangeSummary>,
  options: { holdMs?: number; inFlightMaxMs?: number; concurrency?: number; now?: () => number } = {}
): CheckoutSummaryShare {
  const holdMs = options.holdMs ?? CHECKOUT_SUMMARY_HOLD_MS
  const inFlightMaxMs = options.inFlightMaxMs ?? CHECKOUT_SUMMARY_IN_FLIGHT_MAX_MS
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? CHECKOUT_SUMMARY_CONCURRENCY))
  const now = options.now ?? Date.now
  type Entry = {
    promise: Promise<WorkspaceChangeSummary>
    startedAt: number
    settledAt: number | null
  }
  const reads = new Map<string, Entry>()

  // The one queue every reader shares: a read past the concurrency waits for
  // a slot rather than spawning beside the others. Waiting reads are still
  // shared by key, so a checkout asked for twice while queued is read once.
  let running = 0
  const waiting: Array<() => void> = []
  function acquire(): Promise<void> {
    if (running < concurrency) {
      running += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => waiting.push(resolve))
  }
  function release(): void {
    const next = waiting.shift()
    if (next) next()
    else running -= 1
  }
  async function limitedRead(checkoutPath: string): Promise<WorkspaceChangeSummary> {
    await acquire()
    try {
      return await read(checkoutPath)
    } finally {
      release()
    }
  }

  function shareable(entry: Entry, at: number): boolean {
    return entry.settledAt === null
      ? at - entry.startedAt < inFlightMaxMs
      : at - entry.settledAt < holdMs
  }

  return {
    read(checkoutPath) {
      // Rows on one checkout arrive with whatever path their workspace stores;
      // a trailing slash or a Windows separator must not split the share.
      const key = checkoutPath.replace(/\\/g, '/').replace(/\/+$/u, '')
      const at = now()
      // Opportunistic prune: the map is small (one entry per polled checkout),
      // so this costs nothing and keeps a closed workspace's entry from being
      // retained until the process ends.
      for (const [existingKey, entry] of reads) {
        if (!shareable(entry, at)) reads.delete(existingKey)
      }
      const existing = reads.get(key)
      if (existing) return existing.promise

      const entry: Entry = { promise: limitedRead(checkoutPath), startedAt: at, settledAt: null }
      entry.promise.then(
        () => {
          entry.settledAt = now()
        },
        () => {
          if (reads.get(key) === entry) reads.delete(key)
        }
      )
      reads.set(key, entry)
      return entry.promise
    },
  }
}

const defaultCheckoutSummaries = createCheckoutSummaryShare(readCheckoutSummary)
