import type { AgentPhase } from '../shared/electron-api'
import type { CheckpointIndex } from './checkpoint-index'
import { checkpointRefFor } from './checkpoint-store'
import { classifyTurnBoundary, type TurnBoundary } from './checkpoint-turns'

/**
 * Turns become checkpoints (the-diff-an-agent-made / checkpoint-turn-reactor).
 *
 * Sits on the hook-frame ingestion path and, on a turn boundary, captures. It
 * owns none of the three things it coordinates — the boundary rule lives in
 * `checkpoint-turns`, the git plumbing in `checkpoint-store`, the bookkeeping in
 * `checkpoint-index` — so each is testable without the others, and this file is
 * only the wiring and the concurrency.
 *
 * Every dependency is injected so the reactor's own tests never run git.
 *
 * Two properties matter as much as the captures themselves:
 *
 * - **It never blocks a turn.** `handlePhase` is synchronous and returns
 *   immediately; the capture runs on its own. A hook frame's journey through
 *   `ingestAgentStateFrame` must not wait on `git add -A` over a large repo.
 * - **It never storms.** One capture at a time per folder, and repeated
 *   boundaries of the same kind for the same workspace collapse into one,
 *   because the later one would snapshot the same newer tree.
 *
 * The queue below is a FIFO of INTENTS rather than of resolved turn numbers,
 * and that shape is load-bearing. Two bugs an adversarial review found in the
 * first version came from deciding too early:
 *
 * - a single `pending` slot keyed only by folder let workspace B's boundary
 *   REPLACE workspace A's, so A's turn was captured never — and two workspaces
 *   in one repo is the configuration the per-folder serialisation exists for;
 * - reading `hasBaseline()` at schedule time meant a turn that closed while its
 *   own baseline capture was still running saw no baseline and scheduled turn 0
 *   a second time, losing the first turn of every workspace whose first turn was
 *   shorter than an `add -A`.
 *
 * Both are gone because an intent resolves against the index at the moment it
 * runs, in order, with nothing else touching that folder.
 */

type CaptureIntent = {
  workspaceId: string
  cwd: string
  kind: TurnBoundary & ('open' | 'close')
}

export type CheckpointReactorDeps = {
  index: CheckpointIndex
  captureCheckpoint: (input: { cwd: string; ref: string }) => Promise<boolean>
  deleteCheckpointRefs: (input: { cwd: string; refs: readonly string[] }) => Promise<void>
  now: () => number
  /** Diagnostics only. A failed capture is dropped, never retried into a storm. */
  onCaptureFailed?: (input: { workspaceId: string; cwd: string; ref: string }) => void
}

export type CheckpointReactor = ReturnType<typeof createCheckpointReactor>

export function createCheckpointReactor(deps: CheckpointReactorDeps) {
  // Serialised per FOLDER: two workspaces on one repo share an index lock inside
  // git, and concurrent `add -A` runs there would contend on it. Keyed by cwd so
  // unrelated repos still capture in parallel.
  const queues = new Map<string, CaptureIntent[]>()
  const draining = new Set<string>()

  function enqueue(intent: CaptureIntent): void {
    const queue = queues.get(intent.cwd) ?? []
    // Collapse only a DUPLICATE — same workspace, same kind. A burst of closes
    // is one capture; another workspace's close, or this workspace's open, is
    // its own turn and must survive.
    const duplicate = queue.some(
      (queued) => queued.workspaceId === intent.workspaceId && queued.kind === intent.kind
    )
    if (duplicate) return
    queue.push(intent)
    queues.set(intent.cwd, queue)
    if (!draining.has(intent.cwd)) void drain(intent.cwd)
  }

  async function drain(cwd: string): Promise<void> {
    if (draining.has(cwd)) return
    draining.add(cwd)
    try {
      // A loop, not recursion: a long burst would otherwise stack one suspended
      // frame per coalesced round until the whole chain unwound.
      for (;;) {
        const queue = queues.get(cwd)
        const intent = queue?.shift()
        if (!intent) break
        try {
          await runIntent(intent)
        } catch {
          // A capture that throws is a capture that did not happen. The row
          // falls back to the folder-scoped reading; nothing here may take out
          // the hook-ingestion path that queued it.
        }
      }
      queues.delete(cwd)
    } finally {
      draining.delete(cwd)
    }
  }

  /**
   * Resolve an intent against the index and capture. Runs with nothing else
   * touching this folder, so what it reads is what is true.
   */
  async function runIntent(intent: CaptureIntent): Promise<void> {
    const hasBaseline = deps.index.hasBaseline(intent.workspaceId)

    if (intent.kind === 'open') {
      // Only the very first turn of a workspace needs a baseline captured here:
      // every later turn opens on top of the checkpoint its predecessor's close
      // already left behind.
      //
      // Known gap recorded in the epic: edits the PERSON
      // makes between one turn closing and the next opening land in the next
      // turn's diff. Recapturing the top ref on every open would fix the step
      // and destroy the span, since turn 0 is what the span measures from.
      if (hasBaseline) return
      await captureTurn({ ...intent, turn: 0 })
      return
    }

    // A close with no baseline means we never saw this turn open — a frame lost,
    // or the app started mid-turn. Capturing turn 1 against a baseline that does
    // not exist would diff against nothing, so take the baseline now and let the
    // NEXT turn be the first one measured. An honest empty span beats a
    // fabricated one.
    if (!hasBaseline) {
      await captureTurn({ ...intent, turn: 0 })
      return
    }
    await captureTurn({ ...intent, turn: deps.index.nextTurn(intent.workspaceId) })
  }

  async function captureTurn(input: {
    workspaceId: string
    cwd: string
    turn: number
  }): Promise<void> {
    // Null for an id that cannot own a ref (empty, or not a string from an
    // untyped caller). Nothing to capture, and nothing to record against.
    const ref = checkpointRefFor(input.workspaceId, input.turn)
    if (ref === null) return
    const captured = await deps.captureCheckpoint({ cwd: input.cwd, ref })
    if (!captured) {
      deps.onCaptureFailed?.({ workspaceId: input.workspaceId, cwd: input.cwd, ref })
      return
    }
    // Recorded only on success: an index entry pointing at a ref that was never
    // written would make every later diff resolve against nothing.
    const recorded = deps.index.recordTurn({
      workspaceId: input.workspaceId,
      cwd: input.cwd,
      turn: input.turn,
      ref,
      at: deps.now(),
    })
    // Evictions are acted on ONLY when the bookkeeping actually reached disk.
    // Deleting refs the persisted index still lists would leave that index
    // pointing at refs that no longer resolve after a restart.
    if (recorded.persisted && recorded.evicted.length > 0) {
      await deps.deleteCheckpointRefs({ cwd: input.cwd, refs: recorded.evicted })
    }
  }

  return {
    /**
     * Feed a phase transition. Fire-and-forget by design — see the note above
     * about never blocking a turn.
     *
     * `cwd` is where the agent actually works: its worktree when it has one,
     * the workspace's folder otherwise. That single line is why checkpoints
     * need no worktree — the same call shape covers both.
     */
    handlePhase(input: {
      workspaceId: string
      cwd: string
      previous: AgentPhase | undefined | null
      next: AgentPhase
    }): void {
      if (!input.workspaceId || !input.cwd) return
      const boundary = classifyTurnBoundary(input.previous, input.next)
      if (boundary === null) return
      enqueue({ workspaceId: input.workspaceId, cwd: input.cwd, kind: boundary })
    },

    /**
     * Drop a workspace's checkpoints from the index and the repo (epic decision
     * 8). Called when a workspace is deleted, archived, or forgotten.
     */
    async forgetWorkspace(workspaceId: string): Promise<void> {
      const forgotten = deps.index.forget(workspaceId)
      if (!forgotten || forgotten.refs.length === 0) return
      // Grouped by the cwd each turn was captured in: a workspace whose agent
      // moved to a worktree mid-life has refs recorded against two paths, and
      // both hold the same shared ref store only when they share a repo.
      const byCwd = new Map<string, string[]>()
      for (const entry of forgotten.refs) {
        const list = byCwd.get(entry.cwd)
        if (list) list.push(entry.ref)
        else byCwd.set(entry.cwd, [entry.ref])
      }
      for (const [cwd, refs] of byCwd) {
        await deps.deleteCheckpointRefs({ cwd, refs })
      }
    },

    /** Test seam: resolves once every queued and in-flight capture has settled. */
    async whenSettled(): Promise<void> {
      for (let guard = 0; guard < 1000; guard += 1) {
        if (draining.size === 0 && queues.size === 0) return
        // Yield: draining folders resolve on their own microtasks, and a queue
        // can gain work while another drains.
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      // A seam that lied about being settled would make every test downstream
      // of it meaningless.
      throw new Error('checkpoint reactor did not settle')
    },
  }
}
