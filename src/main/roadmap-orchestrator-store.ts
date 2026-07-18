// Crash-safe persistence for the roadmap orchestrator's only durable state: the
// per-lane runtime (active run ref, parked reason, pending approval). Everything
// else re-derives from backlog + run records on restart, so this store is small
// and its loss degrades to "re-derive from scratch", never to a wrong conclusion.
//
// One sidecar per roadmap, under `.multi-code/sprintengine/roadmaps/<slug>.json`
// — app-owned bookkeeping the engine neither reads nor validates, kept out of the
// roadmap markdown so a policy edit and an orchestrator write never contend.
// Writes are atomic (tmp + rename) and serialized per roadmap, mirroring
// `sprintengine-automation-service.ts`'s sidecar discipline; a malformed or
// missing file reads as empty rather than throwing.

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import type { RoadmapLaneRuntime, RoadmapParkReason } from '../shared/sprintengine/roadmap-orchestrator'

const ROADMAP_RUNTIME_SCHEMA_VERSION = 1
const ROADMAP_RUNTIME_DIR = ['.multi-code', 'sprintengine', 'roadmaps'] as const

export type RoadmapRuntimeRecord = {
  schemaVersion: number
  // The project-relative roadmap file this record belongs to, e.g.
  // `backlog/roadmaps/platform.md`.
  roadmapRef: string
  lanes: RoadmapLaneRuntime[]
}

const PARK_REASONS: ReadonlySet<RoadmapParkReason> = new Set<RoadmapParkReason>([
  'run_failed',
  'run_canceled',
  'needs_input',
  'pr_closed',
  'merge_failed',
  'start_failed',
  'eligibility_contradiction',
])

// The sidecar path for a roadmap, keyed by its file-name stem so two roadmaps
// never collide. `queueKey` is the resolved path so aliases share one write
// queue.
export function roadmapRuntimePath(workspaceRoot: string, roadmapRef: string): { path: string; queueKey: string } {
  const slug = roadmapSlug(roadmapRef)
  const path = join(workspaceRoot, ...ROADMAP_RUNTIME_DIR, `${slug}.json`)
  return { path, queueKey: resolve(path) }
}

function roadmapSlug(roadmapRef: string): string {
  const name = roadmapRef.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? roadmapRef
  const stem = name.replace(/\.md$/i, '')
  // Contain the slug to a single safe path segment — a roadmap ref is authored
  // input; dot segments and separators must not escape the runtime dir.
  return stem.replace(/[^a-zA-Z0-9._-]/g, '_') || 'roadmap'
}

export function createRoadmapOrchestratorStore(workspaceRoot: string) {
  const writeQueues = new Map<string, Promise<unknown>>()

  function enqueue<T>(queueKey: string, task: () => Promise<T>): Promise<T> {
    const tail = writeQueues.get(queueKey) ?? Promise.resolve()
    const next = tail.then(task, task)
    const settled = next.catch(() => undefined)
    writeQueues.set(queueKey, settled)
    void settled.then(() => {
      if (writeQueues.get(queueKey) === settled) writeQueues.delete(queueKey)
    })
    return next
  }

  async function read(roadmapRef: string): Promise<Map<string, RoadmapLaneRuntime>> {
    const { path, queueKey } = roadmapRuntimePath(workspaceRoot, roadmapRef)
    return enqueue(queueKey, async () => {
      let raw: string
      try {
        raw = await readFile(path, 'utf8')
      } catch {
        return new Map<string, RoadmapLaneRuntime>()
      }
      return normalizeLanes(safeParse(raw))
    })
  }

  async function write(roadmapRef: string, lanes: ReadonlyMap<string, RoadmapLaneRuntime>): Promise<void> {
    const { path, queueKey } = roadmapRuntimePath(workspaceRoot, roadmapRef)
    const record: RoadmapRuntimeRecord = {
      schemaVersion: ROADMAP_RUNTIME_SCHEMA_VERSION,
      roadmapRef,
      lanes: [...lanes.values()].map(normalizeLane).filter((lane): lane is RoadmapLaneRuntime => lane !== null),
    }
    await enqueue(queueKey, async () => {
      await mkdir(dirname(path), { recursive: true })
      const tmpPath = `${path}.tmp-${process.pid}`
      await writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      try {
        await rename(tmpPath, path)
      } catch (error) {
        await unlink(tmpPath).catch(() => undefined)
        throw error
      }
    })
  }

  return { read, write }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function normalizeLanes(parsed: unknown): Map<string, RoadmapLaneRuntime> {
  const out = new Map<string, RoadmapLaneRuntime>()
  if (!isRecord(parsed) || !Array.isArray(parsed.lanes)) return out
  for (const raw of parsed.lanes) {
    const lane = normalizeLane(raw)
    if (lane) out.set(lane.lane, lane)
  }
  return out
}

// Field-by-field tolerant validation: an unknown or corrupt lane record is
// dropped, never read as a live run. The runtime is bookkeeping — dropping a bad
// row degrades to re-derivation, so a strict schema would be worse than lenient.
function normalizeLane(raw: unknown): RoadmapLaneRuntime | null {
  if (!isRecord(raw) || typeof raw.lane !== 'string' || raw.lane.length === 0) return null
  const lane: RoadmapLaneRuntime = { lane: raw.lane }
  if (typeof raw.activeItemRef === 'string') lane.activeItemRef = raw.activeItemRef
  if (typeof raw.activeStatePath === 'string') lane.activeStatePath = raw.activeStatePath
  if (typeof raw.activeTeamSlug === 'string') lane.activeTeamSlug = raw.activeTeamSlug
  if (typeof raw.activeRepoId === 'string') lane.activeRepoId = raw.activeRepoId
  if (typeof raw.pendingApprovalRef === 'string') lane.pendingApprovalRef = raw.pendingApprovalRef
  if (isRecord(raw.parked) && typeof raw.parked.itemRef === 'string' && isParkReason(raw.parked.reason)) {
    lane.parked = {
      reason: raw.parked.reason,
      itemRef: raw.parked.itemRef,
      at: typeof raw.parked.at === 'string' ? raw.parked.at : '',
      ...(typeof raw.parked.detail === 'string' ? { detail: raw.parked.detail } : {}),
    }
  }
  return lane
}

function isParkReason(value: unknown): value is RoadmapParkReason {
  return typeof value === 'string' && PARK_REASONS.has(value as RoadmapParkReason)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
