// Wires the roadmap orchestrator's ports to the real main-process collaborators:
// the backlog service (item listing + execution links), the Sprint Engine front
// doors (projection read, PR status/merge), the renderer creation delegate
// (`sprint.create`), the single instance-global sidecar store, the home-project
// setting (D1), and the user notification channel. Kept separate from
// `automations-module.ts` so the module wiring stays small and this glue is
// unit-inspectable in isolation.

import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { AutomationRendererRequest, AutomationRendererResponse } from '../shared/automation'
import { listBacklogItems, readBacklogObjectStore, removeBacklogLink, updateBacklogStatus } from './backlog-service'
import { createRoadmapOrchestratorStore, roadmapRuntimePath } from './roadmap-orchestrator-store'
import type {
  RoadmapBacklogItem,
  RoadmapOrchestratorPorts,
  RoadmapRunRef,
  RoadmapRunSnapshot,
} from './roadmap-orchestrator'
import type { SprintEngineAutomationFrontDoors } from './automations/actions/sprint-engine'
import {
  sprintEngineRunLinkId,
  sprintEngineRunLinkOf,
  teamSlugFromStatePath,
} from '../shared/backlog/sprintengine-links'
import {
  deriveSprintEngineRepoMergeRollup,
  isCanceledSprintEngineRun,
  isCompletedSprintEngineRun,
  normalizeSprintEngineProjection,
  sprintEngineHumanInputTasks,
} from '../shared/sprintengine/state'

export type RoadmapOrchestratorPortsDeps = {
  frontDoors: SprintEngineAutomationFrontDoors
  delegateToRenderer(request: AutomationRendererRequest): Promise<AutomationRendererResponse>
  // The designated home project root (D1), from the roadmap-home setting; null
  // when unset.
  getHomeProjectRoot(): string | null
  // Open workspace roots (from the workspace sync snapshot), for resolving aliases.
  getWorkspaceRoots(): string[]
  notify(input: { severity: 'info' | 'warning' | 'error'; title: string; body?: string }): void
}

export function createRoadmapOrchestratorPorts(deps: RoadmapOrchestratorPortsDeps): RoadmapOrchestratorPorts {
  // The single instance store is rooted at the CURRENT home project (D1). Cached by
  // home root so its serialized write queue is shared across reconciles; a home
  // reassignment simply news up a store rooted at the new project.
  const stores = new Map<string, ReturnType<typeof createRoadmapOrchestratorStore>>()
  const storeForHome = (): ReturnType<typeof createRoadmapOrchestratorStore> | null => {
    const home = deps.getHomeProjectRoot()
    if (!home) return null
    const existing = stores.get(home)
    if (existing) return existing
    const created = createRoadmapOrchestratorStore(home)
    stores.set(home, created)
    return created
  }

  return {
    getHomeProjectRoot: () => deps.getHomeProjectRoot(),
    listWorkspaceRoots: () => deps.getWorkspaceRoots(),

    listBacklogItems: async (workspaceRoot) => {
      const result = await listBacklogItems(workspaceRoot)
      if (!result.ok) return []
      return result.items.map(
        (item): RoadmapBacklogItem => ({
          relativePath: item.relativePath,
          status: item.status ?? 'idea',
          title: item.title,
          ...(item.id !== undefined ? { numericId: item.id } : {}),
          ...(item.dependsOn ? { dependsOn: item.dependsOn } : {}),
          ...(item.isRoadmap ? { isRoadmap: true } : {}),
          ...(item.isEpic ? { isEpic: true } : {}),
          ...(item.epic ? { epic: item.epic } : {}),
        }),
      )
    },

    readRoadmapFile: async (workspaceRoot, relativePath) => {
      try {
        return await readFile(join(workspaceRoot, relativePath), 'utf8')
      } catch {
        return null
      }
    },

    writeRoadmapFile: async (workspaceRoot, relativePath, content) => {
      const target = join(workspaceRoot, relativePath)
      await mkdir(dirname(target), { recursive: true })
      // Atomic tmp + rename, matching the sidecar store's discipline: a crash
      // mid-write can never leave the plan file half-written.
      const tmpPath = `${target}.tmp-${process.pid}`
      await writeFile(tmpPath, content, 'utf8')
      try {
        await rename(tmpPath, target)
      } catch (error) {
        await unlink(tmpPath).catch(() => undefined)
        throw error
      }
    },

    appendAudit: async (roadmapRef, entry) => {
      const home = deps.getHomeProjectRoot()
      if (!home) return
      // Beside the lane-runtime sidecar: `<homeRoot>/.multi-code/sprintengine/
      // roadmaps/<slug>.audit.jsonl`. Append-only JSONL so "the agent merged it" is
      // always reconstructible and a re-read never has to parse a growing object.
      const auditPath = roadmapRuntimePath(home, roadmapRef).path.replace(/\.json$/, '.audit.jsonl')
      await mkdir(dirname(auditPath), { recursive: true })
      await appendFile(auditPath, `${JSON.stringify(entry)}\n`, 'utf8')
    },

    resolveExecutionLink: async (workspaceRoot, itemRelativePath) => {
      const store = await readBacklogObjectStore(workspaceRoot)
      if (!store.ok) return null
      const record = store.store.items.find(
        (candidate) => candidate.source.relativePath.toLowerCase() === itemRelativePath.toLowerCase(),
      )
      const link = record?.links ? sprintEngineRunLinkOf(record.links) : null
      if (!link?.target.path) return null
      return { statePath: join(workspaceRoot, link.target.path), teamSlug: link.target.id }
    },

    observeRun: async (runRef) => observeRun(deps.frontDoors, runRef),

    mergePullRequest: async (statePath) => {
      const result = await deps.frontDoors.mergePullRequest({ statePath })
      return result.ok ? { ok: true } : { ok: false, message: result.message }
    },

    startSprint: async ({ workspaceRoot, itemRelativePath, team }) => {
      // The shared plan-sourced creation flow — the same `sprint.create` delegate a
      // human backlog start and sprint chaining use. It creates the workspace, inits
      // the run store (worktree mode), starts the runner, and records the execution
      // link, in the item's own project root. Worktree mode is on so the lane gates
      // on a PR (MC-1439). An epic source is fine — the run's brief is the epic and
      // the architect plans its members as tasks (one sprint per roadmap STEP).
      // `team` names the roadmap's saved roster; the delegate fails explicitly on an
      // unknown name rather than silently staffing a fallback.
      const response = await deps.delegateToRenderer({
        kind: 'sprint.create',
        folderPath: workspaceRoot,
        goal: '',
        sourceRelativePath: itemRelativePath,
        startRunner: true,
        useWorktrees: true,
        ...(team ? { team } : {}),
      })
      return response.ok ? { ok: true } : { ok: false, message: response.message }
    },

    abandonRun: async (workspaceRoot, itemRelativePath, teamSlug) => {
      // Remove the execution link so the reconcile cannot re-adopt the dead run.
      // Prefer the lane's recorded team slug; fall back to the link on disk.
      const slug = teamSlug ?? (await resolveTeamSlug(workspaceRoot, itemRelativePath))
      if (slug) {
        await removeBacklogLink({ workspaceRoot, relativePath: itemRelativePath, linkId: sprintEngineRunLinkId(slug) }).catch(
          () => undefined,
        )
      }
      // Reset the item so it is eligible to start a fresh sprint.
      await updateBacklogStatus({ workspaceRoot, relativePath: itemRelativePath, status: 'ready' }).catch(() => undefined)
    },

    readLaneRuntime: (roadmapRef, legacyRoots) => {
      const store = storeForHome()
      return store ? store.read(roadmapRef, legacyRoots) : Promise.resolve(new Map())
    },
    writeLaneRuntime: (roadmapRef, lanes) => {
      const store = storeForHome()
      return store ? store.write(roadmapRef, lanes) : Promise.resolve()
    },

    notify: deps.notify,
    logDiagnostic: (input) => {
      console.warn(`[roadmap-orchestrator] ${input.title}: ${input.message}`)
    },
    now: () => new Date(),
  }
}

// The team slug on an item's execution link, read off the object store — the
// fallback for abandoning a run whose lane runtime never captured its slug.
async function resolveTeamSlug(workspaceRoot: string, itemRelativePath: string): Promise<string | undefined> {
  const store = await readBacklogObjectStore(workspaceRoot)
  if (!store.ok) return undefined
  const record = store.store.items.find(
    (candidate) => candidate.source.relativePath.toLowerCase() === itemRelativePath.toLowerCase(),
  )
  const link = record?.links ? sprintEngineRunLinkOf(record.links) : null
  return link?.target.id
}

// Derive a run's coarse lifecycle + mode + PR/merge state from its projection.
// `null` when the run store is gone. A worktree run awaiting merge is refreshed
// through `vcs pr-status` first, so the merge decision reads current GitHub state
// — bounded to exactly the awaiting-merge window, never a per-tick GitHub poll.
async function observeRun(
  frontDoors: SprintEngineAutomationFrontDoors,
  runRef: RoadmapRunRef,
): Promise<RoadmapRunSnapshot | null> {
  const teamSlug = teamSlugFromStatePath(runRef.statePath) ?? runRef.teamSlug
  const read = await frontDoors.readProjection({ statePath: runRef.statePath })
  if (!read.ok) {
    return null
  }
  let state = normalizeSprintEngineProjection(read.data, teamSlug)
  if (!state) return null

  const mode = state.vcs?.mode === 'run_worktree' ? 'worktree' : 'shared'
  const completed = isCompletedSprintEngineRun(state)

  // Refresh + re-read PR state only while a worktree run is completed and not yet
  // all-merged — the one window where merge freshness changes a decision.
  if (mode === 'worktree' && completed && deriveSprintEngineRepoMergeRollup(state.vcs)?.allMerged !== true) {
    await frontDoors.refreshPullRequestStatus({ statePath: runRef.statePath }).catch(() => undefined)
    const refreshed = await frontDoors.readProjection({ statePath: runRef.statePath })
    if (refreshed.ok) {
      const next = normalizeSprintEngineProjection(refreshed.data, teamSlug)
      if (next) state = next
    }
  }

  const lifecycle = deriveLifecycle(state, completed)
  const rollup = deriveSprintEngineRepoMergeRollup(state.vcs)
  const prClosedUnmerged = (state.vcs?.repos ?? []).some((repo) => repo.pullRequestState === 'closed')

  return {
    mode,
    lifecycle,
    ...(mode === 'worktree' ? { prAllMerged: rollup?.allMerged === true } : {}),
    ...(prClosedUnmerged ? { prClosedUnmerged: true } : {}),
  }
}

function deriveLifecycle(
  state: ReturnType<typeof normalizeSprintEngineProjection>,
  completed: boolean,
): RoadmapRunSnapshot['lifecycle'] {
  if (!state) return 'executing'
  if (isCanceledSprintEngineRun(state)) return 'canceled'
  if (completed) return 'completed'
  // A task blocked on the human parks the lane; architect-routed blocks do not.
  if (sprintEngineHumanInputTasks(state).length > 0) return 'needs_input_user'
  return 'executing'
}
