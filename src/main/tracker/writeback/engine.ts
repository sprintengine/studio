import type { TrackerCapabilities, TrackerProviderId } from '../../../shared/tracker/types'
import {
  trackerWriteBackPostKey,
  type TrackerWriteBackConfig,
  type TrackerWriteBackPostKind,
} from '../../../shared/tracker/writeback'
import { pullRequestComment, runCompletedComment, runStartedComment } from './messages'

// The tracker write-back engine (MC-1640 / plan §3.7). RECONCILES a run's proxy
// items against the tracker: on each real lifecycle observation it computes the
// set of posts that SHOULD exist given the genuinely-observed run state, then
// posts each one not already recorded as done. This reconcile model gives all
// four contract guarantees at once:
//   - Idempotent: the ledger dedupes by (run id + event + external id), so a
//     projection replay or app restart never double-posts.
//   - Honest: `completed` comes from the run store (isCompletedSprintEngineRun on
//     a fresh projection read), never a stale rendered projection.
//   - Failure-isolated: every post is caught; a failure records a visible notice
//     and continues, and reconcile NEVER throws into the run lifecycle.
//   - Retrying: a failed post is not recorded as posted, so the next real event
//     re-attempts it while its desired state still holds.
//
// The engine is pure orchestration over injected ports; the real adapters (run
// store read, backlog proxy lookup, provider poster) live alongside it and are
// swapped for fakes in tests.

// The genuinely-observed state of one run instance, read from the run store.
export type RunWriteBackFacts = {
  // Stable identity of this run INSTANCE, durable across restart and projection
  // replay (team slug + creation fingerprint). The idempotency key's run id.
  runId: string
  goal: string
  // The run has a plan and is executing — the earliest stable, honest "started"
  // signal in the main process (there is no run-started push event).
  started: boolean
  // Verified against the run store, never a rendered projection: ≥1 task and
  // every task done, and NOT canceled. This is the projection-freeze guard.
  completed: boolean
  canceled: boolean
  // Every delivered pull request URL, distinct, primary project first.
  pullRequestUrls: string[]
  taskCount: number
}

export type RunStateReader = {
  // Null when the run is unreadable or absent — no facts ⇒ no posts (honest).
  readRunFacts(input: { statePath: string }): Promise<RunWriteBackFacts | null>
}

// One tracker proxy backlog item linked to the run being reconciled.
export type RunProxyItem = {
  relativePath: string
  provider: TrackerProviderId
  connectionId: string
  externalId: string
  nativeKey: string
}

export type ProxyItemLookup = {
  proxyItemsForRun(input: { workspaceRoot: string; statePath: string }): Promise<RunProxyItem[]>
}

export type WriteBackCapabilityResolver = {
  // undefined when no provider client is registered for this tracker.
  capabilitiesFor(provider: TrackerProviderId): TrackerCapabilities | undefined
}

export type TrackerWriteBackPoster = {
  postComment(input: { provider: TrackerProviderId; connectionId: string; externalId: string; body: string }): Promise<void>
  transitionIssue(input: {
    provider: TrackerProviderId
    connectionId: string
    externalId: string
    transitionId: string
  }): Promise<void>
}

export type WriteBackConfigReader = {
  get(connectionId: string): Promise<TrackerWriteBackConfig>
  // Cheap gate: any connection with active write-back at all? Lets reconcile skip
  // the backlog scan when write-back is off everywhere (zero-connection parity).
  anyActive(): Promise<boolean>
}

export type WriteBackLedgerPort = {
  hasPosted(key: string): Promise<boolean>
  markPosted(meta: LedgerWriteMeta): Promise<void>
  recordFailure(meta: LedgerWriteMeta): Promise<void>
}

type LedgerWriteMeta = {
  key: string
  connectionId: string
  externalId: string
  provider: TrackerProviderId
  postKind: TrackerWriteBackPostKind
  relativePath: string
  at: string
  message?: string
}

export type TrackerWriteBackEngineDeps = {
  runState: RunStateReader
  proxyItems: ProxyItemLookup
  config: WriteBackConfigReader
  capabilities: WriteBackCapabilityResolver
  poster: TrackerWriteBackPoster
  ledger: WriteBackLedgerPort
  now: () => Date
  logDiagnostic?: (event: string, payload: Record<string, unknown>) => void
}

export type ReconcileSummary = {
  posted: number
  failed: number
  skipped: number
  // A terminal reason the reconcile did nothing, for diagnostics. Never thrown.
  reason?: 'no_active_config' | 'run_unreadable' | 'not_started' | 'no_proxy_items' | 'error'
}

// One post the run's current state implies. Comments carry a rendered body;
// transitions carry the user-mapped named transition id.
type DesiredPost =
  | { postKind: TrackerWriteBackPostKind; type: 'comment'; body: string }
  | { postKind: TrackerWriteBackPostKind; type: 'transition'; transitionId: string }

export class TrackerWriteBackEngine {
  constructor(private readonly deps: TrackerWriteBackEngineDeps) {}

  // Reconcile every proxy item on a run against the tracker. Never throws — a
  // failure to read state, list items, or post is contained and reported.
  async reconcileRun(input: { statePath: string; workspaceRoot: string }): Promise<ReconcileSummary> {
    try {
      if (!(await this.deps.config.anyActive())) {
        return { posted: 0, failed: 0, skipped: 0, reason: 'no_active_config' }
      }

      const facts = await this.deps.runState.readRunFacts({ statePath: input.statePath })
      if (!facts) return { posted: 0, failed: 0, skipped: 0, reason: 'run_unreadable' }
      if (!facts.started) return { posted: 0, failed: 0, skipped: 0, reason: 'not_started' }

      const items = await this.deps.proxyItems.proxyItemsForRun({
        workspaceRoot: input.workspaceRoot,
        statePath: input.statePath,
      })
      if (items.length === 0) return { posted: 0, failed: 0, skipped: 0, reason: 'no_proxy_items' }

      let posted = 0
      let failed = 0
      let skipped = 0
      for (const item of items) {
        const config = await this.deps.config.get(item.connectionId)
        if (!config.enabled) {
          // Disabling mid-run stops future posts; already-posted comments stay.
          skipped += 1
          continue
        }
        const capabilities = this.deps.capabilities.capabilitiesFor(item.provider)
        const desired = desiredPostsFor(facts, config, capabilities)
        for (const post of desired) {
          const key = trackerWriteBackPostKey({ runId: facts.runId, postKind: post.postKind, externalId: item.externalId })
          if (await this.deps.ledger.hasPosted(key)) {
            skipped += 1
            continue
          }
          const outcome = await this.attempt(item, post, key)
          if (outcome === 'posted') posted += 1
          else failed += 1
        }
      }
      return { posted, failed, skipped }
    } catch (err) {
      // The last line of failure isolation: even a bug in the reconcile itself
      // must never surface into the run lifecycle that called us.
      this.deps.logDiagnostic?.('tracker_writeback_reconcile_error', {
        statePath: input.statePath,
        message: errorMessage(err),
      })
      return { posted: 0, failed: 0, skipped: 0, reason: 'error' }
    }
  }

  private async attempt(item: RunProxyItem, post: DesiredPost, key: string): Promise<'posted' | 'failed'> {
    const meta: LedgerWriteMeta = {
      key,
      connectionId: item.connectionId,
      externalId: item.externalId,
      provider: item.provider,
      postKind: post.postKind,
      relativePath: item.relativePath,
      at: this.deps.now().toISOString(),
    }
    try {
      if (post.type === 'comment') {
        await this.deps.poster.postComment({
          provider: item.provider,
          connectionId: item.connectionId,
          externalId: item.externalId,
          body: post.body,
        })
      } else {
        await this.deps.poster.transitionIssue({
          provider: item.provider,
          connectionId: item.connectionId,
          externalId: item.externalId,
          transitionId: post.transitionId,
        })
      }
    } catch (err) {
      // A post failure is isolated to this item+event: record the visible notice
      // and move on. Not marking it posted is what makes it retry next event.
      await this.deps.ledger
        .recordFailure({ ...meta, message: errorMessage(err) })
        .catch(() => undefined)
      return 'failed'
    }
    // The post succeeded. Recording it is best-effort and separate: a ledger
    // write failure must never turn a delivered post into a false failure notice
    // (at worst the post re-fires on a later event, which is idempotent upstream).
    await this.deps.ledger.markPosted(meta).catch(() => undefined)
    return 'posted'
  }
}

// The set of posts the run's observed state implies for one proxy item, ordered
// COMMENTS BEFORE TRANSITIONS within each event, and started → PR → completed
// across events. Each is independently gated by the config toggle, the observed
// fact, and the provider capability, so a provider that cannot comment or
// transition simply produces fewer posts (never a rejected call).
export function desiredPostsFor(
  facts: RunWriteBackFacts,
  config: TrackerWriteBackConfig,
  capabilities: TrackerCapabilities | undefined,
): DesiredPost[] {
  const canComment = capabilities?.canComment === true
  const canTransition = capabilities?.canTransition === true
  const posts: DesiredPost[] = []

  if (facts.started) {
    if (canComment && config.comments.started) {
      posts.push({ postKind: 'comment:started', type: 'comment', body: runStartedComment({ goal: facts.goal }) })
    }
    if (canTransition && config.transitions.onStart) {
      posts.push({ postKind: 'transition:onStart', type: 'transition', transitionId: config.transitions.onStart })
    }
  }

  if (facts.pullRequestUrls.length > 0 && canComment && config.comments.pr) {
    posts.push({
      postKind: 'comment:pr',
      type: 'comment',
      body: pullRequestComment({ goal: facts.goal, pullRequestUrls: facts.pullRequestUrls }),
    })
  }

  if (facts.completed) {
    if (canComment && config.comments.done) {
      posts.push({
        postKind: 'comment:done',
        type: 'comment',
        body: runCompletedComment({
          goal: facts.goal,
          pullRequestUrls: facts.pullRequestUrls,
          taskCount: facts.taskCount,
        }),
      })
    }
    if (canTransition && config.transitions.onComplete) {
      posts.push({ postKind: 'transition:onComplete', type: 'transition', transitionId: config.transitions.onComplete })
    }
  }

  return posts
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected write-back error.'
}
