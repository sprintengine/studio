import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * The per-workspace checkpoint timeline: which turns we captured, at which ref,
 * in which folder (the-diff-an-agent-made / checkpoint-turn-reactor).
 *
 * Persisted under userData so a restart does not lose a workspace's span — the
 * refs survive in the repo either way, but without this we would not know that
 * `turn/0` was ours or what the latest turn number is, and would start
 * numbering over the top of live refs.
 *
 * The unit is the WORKSPACE, not the agent (epic decision 2): two agents in one
 * workspace advance one timeline, which is the owner's "add their diffs
 * together" without double-counting a file both of them touched.
 *
 * Never throws. An unreadable or malformed file reads as "no timelines", which
 * degrades every row to the folder-scoped fallback — the same place a fresh
 * install starts.
 */

const FILE_NAME = 'checkpoint-index.json'

/**
 * How many turns one workspace keeps. Turn 0 is never evicted: it is the
 * baseline every span diff measures from, so losing it would silently rescope
 * every number the workspace shows. The cap therefore keeps turn 0 plus the
 * most recent MAX_TURNS_PER_WORKSPACE - 1 turns, and the step-through simply
 * has no steps for the evicted middle — the span stays exact.
 */
export const MAX_TURNS_PER_WORKSPACE = 50

export type CheckpointTurn = {
  turn: number
  ref: string
  at: number
}

export type WorkspaceCheckpoints = {
  /** Where the checkpoints live — a worktree path, or the workspace's folder. */
  cwd: string
  /** Ascending by turn. Index 0 is the baseline whenever one has been captured. */
  turns: CheckpointTurn[]
}

export type CheckpointIndexDeps = {
  resolveUserDataDir: () => string
}

export type CheckpointIndex = ReturnType<typeof createCheckpointIndex>

type Persisted = Record<string, WorkspaceCheckpoints>

function isTurn(value: unknown): value is CheckpointTurn {
  if (!value || typeof value !== 'object') return false
  const turn = value as Record<string, unknown>
  return (
    typeof turn.turn === 'number'
    && Number.isFinite(turn.turn)
    && turn.turn >= 0
    && typeof turn.ref === 'string'
    && turn.ref.length > 0
    && typeof turn.at === 'number'
  )
}

/**
 * Reject anything that is not exactly the shape we wrote. This file is on disk
 * between releases and its `ref` values are handed to `git update-ref -d`, so a
 * corrupted entry is not merely useless — it is a string we would otherwise
 * pass to a delete.
 */
function parsePersisted(raw: unknown): Persisted {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Persisted = {}
  for (const [workspaceId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    if (typeof entry.cwd !== 'string' || entry.cwd.length === 0) continue
    if (!Array.isArray(entry.turns)) continue
    const turns = entry.turns.filter(isTurn).sort((a, b) => a.turn - b.turn)
    if (turns.length === 0) continue
    out[workspaceId] = { cwd: entry.cwd, turns }
  }
  return out
}

export function createCheckpointIndex(deps: CheckpointIndexDeps) {
  let cache: Persisted | null = null

  function filePath(): string {
    return join(deps.resolveUserDataDir(), FILE_NAME)
  }

  function load(): Persisted {
    if (cache !== null) return cache
    try {
      cache = parsePersisted(JSON.parse(readFileSync(filePath(), 'utf8')))
    } catch {
      cache = {}
    }
    return cache
  }

  /** Write through a temp file and rename, so a crash mid-write cannot truncate it. */
  function persist(next: Persisted): void {
    cache = next
    const target = filePath()
    const temp = `${target}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(next), 'utf8')
      renameSync(temp, target)
    } catch {
      try {
        unlinkSync(temp)
      } catch {
        // Nothing to clean up, or nothing we can do about it.
      }
    }
  }

  return {
    /** The workspace's timeline, or null when it has never been captured. */
    timelineFor(workspaceId: string): WorkspaceCheckpoints | null {
      return load()[workspaceId] ?? null
    },

    /**
     * The turn number a NEW capture should use — one past the highest recorded,
     * or 0 for a workspace with no baseline yet.
     */
    nextTurn(workspaceId: string): number {
      const timeline = load()[workspaceId]
      if (!timeline || timeline.turns.length === 0) return 0
      return timeline.turns[timeline.turns.length - 1].turn + 1
    },

    /** Whether the baseline (turn 0) has been captured for this workspace. */
    hasBaseline(workspaceId: string): boolean {
      const timeline = load()[workspaceId]
      return Boolean(timeline?.turns.some((turn) => turn.turn === 0))
    },

    /**
     * Record a captured turn. Returns the refs the cap evicted, so the caller
     * can delete them from the repo — this module owns the bookkeeping and
     * never runs git itself.
     *
     * Recording the same turn twice replaces it rather than duplicating: a
     * recapture is a correction, and two entries for one turn would break the
     * ascending invariant every reader relies on.
     *
     * A `cwd` that differs from the recorded one wins — a workspace moved to a
     * new worktree keeps its timeline, and every ref is addressed by the cwd
     * stored alongside it.
     */
    recordTurn(input: {
      workspaceId: string
      cwd: string
      turn: number
      ref: string
      at: number
    }): { evicted: string[] } {
      const current = load()
      const existing = current[input.workspaceId]
      const kept = (existing?.turns ?? []).filter((turn) => turn.turn !== input.turn)
      const turns = [...kept, { turn: input.turn, ref: input.ref, at: input.at }].sort(
        (a, b) => a.turn - b.turn
      )

      // Cap, preserving the baseline: turn 0 plus the newest of the rest.
      let evicted: CheckpointTurn[] = []
      let retained = turns
      if (turns.length > MAX_TURNS_PER_WORKSPACE) {
        const baseline = turns.filter((turn) => turn.turn === 0)
        const rest = turns.filter((turn) => turn.turn !== 0)
        const keepCount = Math.max(0, MAX_TURNS_PER_WORKSPACE - baseline.length)
        const keptRest = rest.slice(rest.length - keepCount)
        evicted = rest.slice(0, rest.length - keepCount)
        retained = [...baseline, ...keptRest]
      }

      persist({
        ...current,
        [input.workspaceId]: { cwd: input.cwd, turns: retained },
      })
      return { evicted: evicted.map((turn) => turn.ref) }
    },

    /**
     * Drop a workspace's timeline, returning what the caller must delete from
     * the repo. Called when a workspace is deleted or archived (epic decision
     * 8) — nothing may accumulate refs in someone's repo forever.
     */
    forget(workspaceId: string): { cwd: string; refs: string[] } | null {
      const current = load()
      const timeline = current[workspaceId]
      if (!timeline) return null
      const next = { ...current }
      delete next[workspaceId]
      persist(next)
      return { cwd: timeline.cwd, refs: timeline.turns.map((turn) => turn.ref) }
    },

    /** Every workspace with a timeline — for sweeps and diagnostics. */
    workspaceIds(): string[] {
      return Object.keys(load())
    },
  }
}
