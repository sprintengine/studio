import type { AgentPhase } from '../shared/electron-api'
import type { CheckpointIndex } from './checkpoint-index'
import { checkpointRefFor } from './checkpoint-store'
import { classifyTurnBoundary } from './checkpoint-turns'

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
 * - **It never storms.** One capture at a time per folder, and a request
 *   arriving while one runs is COALESCED rather than queued: the later request
 *   would snapshot a newer tree anyway, so running both would spend two
 *   subprocesses to reach the state the second one alone produces.
 */

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
  // Serialised per FOLDER, not per workspace: two workspaces on one repo share
  // an index lock inside git, and concurrent `add -A` runs there would contend
  // on it. Keyed by cwd so unrelated repos still capture in parallel.
  const running = new Map<string, Promise<void>>()
  // Work that arrived while a capture was in flight for the same folder. At most
  // one is held: a third request replaces the second, because both would
  // snapshot the same (newer) tree.
  const pending = new Map<string, () => Promise<void>>()

  function schedule(cwd: string, task: () => Promise<void>): void {
    if (running.has(cwd)) {
      pending.set(cwd, task)
      return
    }
    const drain = async (current: () => Promise<void>): Promise<void> => {
      try {
        await current()
      } catch {
        // A capture that throws is a capture that did not happen. The row falls
        // back to the folder-scoped reading; nothing here may take out the
        // hook-ingestion path that called us.
      }
      const next = pending.get(cwd)
      if (next) {
        pending.delete(cwd)
        await drain(next)
        return
      }
      running.delete(cwd)
    }
    // Recorded BEFORE the first await so a synchronous second call in the same
    // tick sees the lock and coalesces rather than starting a parallel capture.
    const promise = drain(task)
    running.set(cwd, promise)
    void promise
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
    const { evicted } = deps.index.recordTurn({
      workspaceId: input.workspaceId,
      cwd: input.cwd,
      turn: input.turn,
      ref,
      at: deps.now(),
    })
    if (evicted.length > 0) {
      await deps.deleteCheckpointRefs({ cwd: input.cwd, refs: evicted })
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

      if (boundary === 'open') {
        // Only the very first turn of a workspace needs a baseline captured
        // here: every later turn opens on top of the checkpoint its
        // predecessor's close already left behind.
        //
        // Known gap recorded in the epic: edits the
        // PERSON makes between one turn closing and the next opening land in
        // the next turn's diff. Recapturing the top ref on every open would fix
        // the step but destroy the span, since turn 0 is what the span measures
        // from.
        if (deps.index.hasBaseline(input.workspaceId)) return
        schedule(input.cwd, () =>
          captureTurn({ workspaceId: input.workspaceId, cwd: input.cwd, turn: 0 })
        )
        return
      }

      // A close with no baseline means we never saw this turn open — a frame
      // lost, or the app started mid-turn. Capturing turn 1 against a baseline
      // that does not exist would diff against nothing, so take the baseline
      // now and let the NEXT turn be the first one measured. An honest empty
      // span beats a fabricated one.
      if (!deps.index.hasBaseline(input.workspaceId)) {
        schedule(input.cwd, () =>
          captureTurn({ workspaceId: input.workspaceId, cwd: input.cwd, turn: 0 })
        )
        return
      }

      schedule(input.cwd, () =>
        captureTurn({
          workspaceId: input.workspaceId,
          cwd: input.cwd,
          // Read inside the task, not at schedule time: a coalesced pair must
          // not both resolve to the same turn number.
          turn: deps.index.nextTurn(input.workspaceId),
        })
      )
    },

    /**
     * Drop a workspace's checkpoints from the index and the repo (epic decision
     * 8). Called when a workspace is deleted or archived.
     */
    async forgetWorkspace(workspaceId: string): Promise<void> {
      const forgotten = deps.index.forget(workspaceId)
      if (!forgotten || forgotten.refs.length === 0) return
      await deps.deleteCheckpointRefs({ cwd: forgotten.cwd, refs: forgotten.refs })
    },

    /** Test seam: resolves once every in-flight and pending capture has settled. */
    async whenSettled(): Promise<void> {
      // Loop rather than a single await: draining one folder can leave a
      // coalesced task that has not started yet.
      for (let guard = 0; guard < 100; guard += 1) {
        const inFlight = [...running.values()]
        if (inFlight.length === 0) return
        await Promise.all(inFlight)
      }
    },
  }
}
