// Wires the roadmap orchestrator's ports to the real main-process collaborators:
// the backlog service (item listing + execution links), the Sprint Engine front
// doors (projection read, PR status/merge), the renderer creation delegate
// (`sprint.create`), the crash-safe sidecar store, and the user notification
// channel. Kept separate from `automations-module.ts` so the module wiring stays
// small and this glue is unit-inspectable in isolation.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { AutomationRendererRequest, AutomationRendererResponse } from '../shared/automation'
import { listBacklogItems, readBacklogObjectStore } from './backlog-service'
import { createRoadmapOrchestratorStore } from './roadmap-orchestrator-store'
import type {
  RoadmapBacklogItem,
  RoadmapOrchestratorPorts,
  RoadmapRunRef,
  RoadmapRunSnapshot,
} from './roadmap-orchestrator'
import type { SprintEngineAutomationFrontDoors } from './automations/actions/sprint-engine'
import { sprintEngineRunLinkOf, teamSlugFromStatePath } from '../shared/backlog/sprintengine-links'
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
  // Open workspace roots (from the workspace sync snapshot).
  getWorkspaceRoots(): string[]
  notify(input: { severity: 'info' | 'warning' | 'error'; title: string; body?: string }): void
}

export function createRoadmapOrchestratorPorts(deps: RoadmapOrchestratorPortsDeps): RoadmapOrchestratorPorts {
  // One store per workspace root — its serialized write queue must be shared
  // across reconciles, so the instance is cached rather than rebuilt per call.
  const stores = new Map<string, ReturnType<typeof createRoadmapOrchestratorStore>>()
  const storeFor = (workspaceRoot: string) => {
    const existing = stores.get(workspaceRoot)
    if (existing) return existing
    const created = createRoadmapOrchestratorStore(workspaceRoot)
    stores.set(workspaceRoot, created)
    return created
  }

  return {
    listWorkspaceRoots: () => deps.getWorkspaceRoots(),

    listBacklogItems: async (workspaceRoot) => {
      const result = await listBacklogItems(workspaceRoot)
      if (!result.ok) return []
      return result.items.map(
        (item): RoadmapBacklogItem => ({
          relativePath: item.relativePath,
          status: item.status ?? 'idea',
          ...(item.dependsOn ? { dependsOn: item.dependsOn } : {}),
          ...(item.isRoadmap ? { isRoadmap: true } : {}),
          ...(item.isEpic ? { isEpic: true } : {}),
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

    resolveExecutionLink: async (workspaceRoot, itemRef) => {
      const store = await readBacklogObjectStore(workspaceRoot)
      if (!store.ok) return null
      const record = store.store.items.find(
        (candidate) => candidate.source.relativePath.toLowerCase() === itemRef.toLowerCase(),
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

    startSprint: async ({ workspaceRoot, itemRef }) => {
      // The shared plan-sourced creation flow — the same `sprint.create` delegate
      // a human backlog start and sprint chaining use. It creates the workspace,
      // inits the run store (worktree mode), starts the runner, and records the
      // execution link + epic children fan-out. Worktree mode is on so the lane
      // gates on a PR (MC-1439). The delegate refuses an epic source, so callers
      // only ever pass a concrete child item (nextEligible never yields an epic).
      const response = await deps.delegateToRenderer({
        kind: 'sprint.create',
        folderPath: workspaceRoot,
        goal: '',
        sourceRelativePath: itemRef,
        startRunner: true,
        useWorktrees: true,
      })
      return response.ok ? { ok: true } : { ok: false, message: response.message }
    },

    readLaneRuntime: (workspaceRoot, roadmapRef) => storeFor(workspaceRoot).read(roadmapRef),
    writeLaneRuntime: (workspaceRoot, roadmapRef, lanes) => storeFor(workspaceRoot).write(roadmapRef, lanes),

    notify: deps.notify,
    logDiagnostic: (input) => {
      // Internal diagnostics: surfaced to the main log, never to the user (the
      // user-facing channel is `notify`).
      console.warn(`[roadmap-orchestrator] ${input.title}: ${input.message}`)
    },
    now: () => new Date(),
  }
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
    // A permanently-gone run store (deleted) is "no run"; a transient read error
    // is treated the same for this tick and simply retried next reconcile.
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
    repoId: 'primary',
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
