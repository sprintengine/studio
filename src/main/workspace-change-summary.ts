import { readBranchSpan, type BranchSpan } from './git-branch-span'
import type { WorkspaceChangeSummary } from '../shared/electron-api'

/**
 * What a workspace's row reports as changed
 * (the-diff-an-agent-made / branch-scoped-row-diff).
 *
 * The reading is the branch the agent's checkout is on:
 * `merge-base(HEAD, <default branch>) → working tree`. Whatever the person
 * already had committed on the default branch sits on both sides of that base
 * and never enters the number, and — the property the checkpoint model could
 * not have — a pull, a merge or a commit landing under the agent moves HEAD and
 * the base together, so ordinary repo movement is invisible here by
 * construction.
 *
 * `scope` is the honesty contract, not a debug field. It says how much the
 * caller is entitled to claim, and the row's tooltip and spoken label are
 * derived from it:
 *
 * - `worktree` — a LINKED worktree, so nothing else writes into this checkout.
 *   The numbers are this chat's work.
 * - `branch`   — a shared checkout carrying commits the default branch does
 *   not. The numbers are the BRANCH's work, which may include commits a person
 *   or another chat made on it.
 * - `folder`   — a shared checkout level with the default branch. There is no
 *   branch work to attribute, so all that can honestly be said is what is
 *   uncommitted in the folder.
 *
 * The rule this file exists to enforce is unchanged from the reading it
 * replaces: never claim more than the checkout can support. What changed is
 * that the claim is now derived from git's own facts rather than from
 * bookkeeping we maintained.
 */
export async function getWorkspaceChangeSummary(
  input: { checkoutPath: string },
  deps: { spans?: CheckoutSpanShare } = {}
): Promise<WorkspaceChangeSummary> {
  const span = await (deps.spans ?? defaultCheckoutSpans).read(input.checkoutPath)
  return summaryFromSpan(span)
}

/**
 * The pure half: a span becomes a summary. Separated so the scope rule — the
 * one thing a reviewer needs to check — tests without a repo.
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
    // A linked worktree is exclusive to its workspace whatever its branch is
    // doing, so it claims `worktree` even when level with the default branch:
    // the uncommitted work in it is still nobody else's.
    scope: span.isLinkedWorktree ? 'worktree' : span.aheadOfBase ? 'branch' : 'folder',
  }
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
 * A folder's read is shared while it is in flight and held for `holdMs` after it
 * settles, which covers a sweep's serial tail at the poll's concurrency of four;
 * the next sweep always gets a fresh read. The hold is measured from settle
 * rather than start on purpose — a slow read on a large repo must not expire
 * while the rows queued behind it are still arriving.
 *
 * A rejected read is forgotten immediately, so a transient failure never pins an
 * error onto every row of the checkout for the hold window.
 */
export type CheckoutSpanShare = {
  read: (checkoutPath: string) => Promise<BranchSpan | null>
}

export const CHECKOUT_SPAN_HOLD_MS = 15_000
/**
 * How long an in-flight read is shared before a newcomer starts its own. A
 * `git diff` hung on a spun-down volume must not pin every row of that checkout,
 * in every window, for the life of main — this keeps that worst case per read
 * rather than per checkout.
 */
export const CHECKOUT_SPAN_IN_FLIGHT_MAX_MS = 60_000

export function createCheckoutSpanShare(
  read: (checkoutPath: string) => Promise<BranchSpan | null>,
  options: { holdMs?: number; inFlightMaxMs?: number; now?: () => number } = {}
): CheckoutSpanShare {
  const holdMs = options.holdMs ?? CHECKOUT_SPAN_HOLD_MS
  const inFlightMaxMs = options.inFlightMaxMs ?? CHECKOUT_SPAN_IN_FLIGHT_MAX_MS
  const now = options.now ?? Date.now
  type Entry = { promise: Promise<BranchSpan | null>; startedAt: number; settledAt: number | null }
  const reads = new Map<string, Entry>()
  return {
    read(checkoutPath) {
      // Rows on one checkout arrive with whatever path their workspace stores;
      // a trailing slash or a Windows separator must not split the share.
      const key = checkoutPath.replace(/\\/g, '/').replace(/\/+$/u, '')
      const existing = reads.get(key)
      if (existing) {
        const shareable =
          existing.settledAt === null
            ? now() - existing.startedAt < inFlightMaxMs
            : now() - existing.settledAt < holdMs
        if (shareable) return existing.promise
      }
      const entry: Entry = {
        promise: read(checkoutPath),
        startedAt: now(),
        settledAt: null,
      }
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

const defaultCheckoutSpans = createCheckoutSpanShare(readBranchSpan)
