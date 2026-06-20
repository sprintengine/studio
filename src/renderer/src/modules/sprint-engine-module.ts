import React from 'react'

import type { RendererModule } from './renderer-host'
import { createSprintEngineTemplate, registerSprintEngineWorkspaceTypes } from './sprint-engine-workspace-types'
import { basename } from '../utils/paths'
import { slugifySprintEngineName } from '../utils/sprintengineStateFile'
import { markdownTitle } from '../components/workspace/newWorkspace/helpers'
import { normalizeSprintEngineProjection } from '../utils/sprintengine'
import { dispatchRevealTarget } from '../utils/revealTarget'
import {
  hasSprintEngineRunLink,
  openSprintEngineBacklogLink,
  resolveSprintEngineBacklogLink,
  sprintEngineRunLinkForItem,
  SPRINT_ENGINE_MODULE_ID,
  SPRINT_ENGINE_RUN_TARGET_KIND,
} from '../utils/sprintengineBacklogLinks'
import type { SprintEngineBacklogLinkOpenPorts } from '../utils/sprintengineBacklogLinks'
import type { SprintEngineRoleCliDefaults, SprintEngineRoleId, SprintEngineState, Workspace } from '../types/workspace'

// Lazy so the Sprint Engine board bundle only loads when the panel is actually
// rendered — never, when the module is disabled.
const SprintEngineBoardPanel = React.lazy(
  () => import('../components/panels/SprintEngineBoardPanel')
)

const backlogRunMountCliDefaults: SprintEngineRoleCliDefaults = {
  architect: 'claude-code',
  product: 'claude-code',
  frontend: 'claude-code',
  ui_ux_reviewer: 'claude-code',
  developer: 'claude-code',
  code_reviewer: 'claude-code',
  nuclear_reviewer: 'claude-code',
  spec_reviewer: 'claude-code',
  performance: 'claude-code',
  production_readiness_reviewer: 'claude-code',
  cross_platform: 'claude-code',
  tester: 'claude-code',
  security: 'claude-code',
}

function roleCliDefaultsForMountedRun(state: SprintEngineState, saved: SprintEngineRoleCliDefaults | null | undefined): SprintEngineRoleCliDefaults {
  const defaults = { ...backlogRunMountCliDefaults, ...(saved ?? {}) }
  for (const [agentId, agent] of Object.entries(state.sprintEngineAgents)) {
    const role = agent.role as SprintEngineRoleId
    if (!defaults[role]) defaults[role] = defaults[agentId as SprintEngineRoleId] ?? 'claude-code'
  }
  return defaults
}

function mountedRunDirectoryPath(statePath: string): string {
  return statePath.replace(/[\\/]+run\.ya?ml$/iu, '')
}

async function sprintEngineBacklogOpenPorts(): Promise<SprintEngineBacklogLinkOpenPorts> {
  const [{ useWorkspaceStore }, { publishDiagnostic }] = await Promise.all([
    import('../store/workspaceStore'),
    import('../utils/diagnostics'),
  ])
  const store = useWorkspaceStore.getState()
  return {
    workspaces: store.workspaces,
    setActiveWorkspace: store.setActiveWorkspace,
    openRunSummaryOverlay: store.openRunSummaryOverlay,
    mountWorkspaceForRun: async ({ workspaceRoot, statePath, teamSlug }): Promise<Workspace | null> => {
      const latestStore = useWorkspaceStore.getState()
      const targetKey = statePath.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
      const existing = latestStore.workspaces.find((workspace) =>
        workspace.sprintEngineContext?.statePath
        && workspace.sprintEngineContext.statePath.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase() === targetKey
      )
      if (existing) return existing

      const projection = await window.api.readSprintEngineProjection(statePath)
      if (!projection.ok) {
        throw new Error(projection.message || 'Sprint Engine projection is unavailable.')
      }
      const sprintEngineState = normalizeSprintEngineProjection(projection.data, teamSlug)
      if (!sprintEngineState) {
        throw new Error('Sprint Engine projection is malformed.')
      }

      const teamName = sprintEngineState.name.trim() || teamSlug
      const roleCliDefaults = roleCliDefaultsForMountedRun(
        sprintEngineState,
        latestStore.appSettings.sprintEngineRoleSettings.savedRoster?.roleCliDefaults,
      )
      const workspaceId = latestStore.addWorkspace(
        createSprintEngineTemplate({
          name: teamName,
          goal: sprintEngineState.goal,
          roleCounts: sprintEngineState.roleCounts,
        }),
        {
          name: teamName,
          folderPath: workspaceRoot,
          sprintEngineState,
          sprintEngineContext: {
            teamName,
            teamSlug,
            teamDirectoryPath: mountedRunDirectoryPath(statePath),
            statePath,
          },
          sprintEngineRoleCliDefaults: roleCliDefaults,
          mode: 'sprintengine',
        },
      )
      return useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === workspaceId) ?? null
    },
    publishDiagnostic,
  }
}

// Sprint Engine renderer module. Matches the main-side `sprint-engine` module id
// so the single enablement override gates both processes consistently.
//
// Scope: this gates the user-facing Sprint Engine surfaces — the board panel,
// the `sprintengine` workspace mode (and the dependent `guided-brief` mode), and
// the always-mounted auto-run supervisor + state synchronizer. The Sprint Engine
// MCP hub stays foundational on the main side (lazily started only on a managed
// run), and the `roles` settings tab stays available like the knowledge-graph
// tab does for the memory-graph module.
//
// Only the canonical `sprintengine` board is routed through the host. The
// fixed-view fallbacks, run summary, and plan reader stay local lazy consts in
// WorkspaceLayout because they take props the generic host panel contract
// (`{ workspaceId }`) doesn't carry — the same split git uses for its conflict
// resolver.
export const sprintEngineRendererModule: RendererModule = {
  manifest: {
    id: 'sprint-engine',
    displayName: 'Sprint Engine',
    version: 1,
    publisher: 'multicode',
    category: 'orchestration',
    summary:
      'Autonomous multi-agent sprint board with quality gates. Disabling hides the board, the Sprint Engine and Design Wizard workspace modes, and stops the auto-run supervisor.',
    defaultEnabled: true,
    dependsOn: ['agent-runtime'],
  },
  registerRenderer(host) {
    host.registerPanel('sprintengine', SprintEngineBoardPanel)
    registerSprintEngineWorkspaceTypes(host)
    host.registerBacklogLinkProvider({
      moduleId: SPRINT_ENGINE_MODULE_ID,
      targetKinds: [SPRINT_ENGINE_RUN_TARGET_KIND],
      resolveLinkStatus: (input) => resolveSprintEngineBacklogLink({
        ...input,
        readSprintEngineProjection: window.api.readSprintEngineProjection,
      }),
      openLink: async (input) => openSprintEngineBacklogLink({
        ...input,
        ports: await sprintEngineBacklogOpenPorts(),
      }),
    })
    // Deep-link from a Sprint Engine notification to the task it is about. The
    // shell already reveals the workspace (its generic fallback); this provider
    // adds the board-task focus on top when the notification carries a
    // `{ kind: 'task' }` navigation target. With no task target it returns
    // nothing and the shell's workspace-reveal fallback still gives the user an
    // Open.
    host.registerNotificationActionProvider({
      source: 'sprintengine',
      resolveActions: ({ notification, revealWorkspace }) => {
        const workspaceId = notification.workspaceId
        const target = notification.navigationTarget
        if (!workspaceId || target?.kind !== 'task' || !target.ref) return []
        return [
          {
            id: 'sprint-engine.open-task',
            label: 'Open',
            run: () => {
              revealWorkspace(workspaceId)
              dispatchRevealTarget({ workspaceId, target })
            },
          },
        ]
      },
    })
    host.registerBacklogItemAction({
      id: 'sprint-engine.start-from-backlog',
      label: 'Start Sprint Engine',
      category: 'execute',
      order: 10,
      isVisible: ({ item }) => item.status !== 'archived' && item.status !== 'completed' && !hasSprintEngineRunLink(item),
      getState: ({ startSourcePlan }) => startSourcePlan ? 'enabled' : 'disabled',
      async run(context) {
        if (!context.startSourcePlan) return
        const sourceContent = await context.readSource()
        const baseName = basename(context.item.relativePath).replace(/\.(md|html?)$/i, '')
        const teamName = slugifySprintEngineName(baseName)
        context.startSourcePlan({
          folderPath: context.workspaceRoot,
          sourcePath: context.item.path,
          sourceRelativePath: context.item.relativePath,
          sourceContent,
          sourcePlanKind: sourcePlanKindForBacklogItem(context.item.kind),
          teamName,
          goal: markdownTitle(sourceContent) ?? context.item.title,
        })
      },
    })
    host.registerBacklogItemAction({
      id: 'sprint-engine.open-linked-run',
      label: 'Open Sprint Engine',
      category: 'execute',
      order: 10,
      isVisible: ({ item }) => item.status !== 'archived' && hasSprintEngineRunLink(item),
      async run(context) {
        const link = sprintEngineRunLinkForItem(context.item)
        if (!link) return
        await openSprintEngineBacklogLink({
          ...context,
          link,
          ports: await sprintEngineBacklogOpenPorts(),
        })
      },
    })
  },
}

function sourcePlanKindForBacklogItem(kind: string): 'product_plan' | 'architect_plan' | 'unknown' {
  return kind === 'product_plan' || kind === 'architect_plan' ? kind : 'unknown'
}
