import React from 'react'

import type { RendererModule } from './renderer-host'
import { registerSprintEngineWorkspaceTypes } from './sprint-engine-workspace-types'
import { basename } from '../utils/paths'
import { slugifySprintEngineName } from '../utils/sprintengineStateFile'
import { markdownTitle } from '../components/workspace/newWorkspace/helpers'
import { dispatchRevealTarget } from '../utils/revealTarget'
import { hasAgentLink } from '../utils/agentBacklogLinks'
import {
  hasSprintEngineRunLink,
  openSprintEngineBacklogLink,
  resolveSprintEngineBacklogLink,
  resolveSprintEnginePullRequestLink,
  sprintEngineRunLinkForItem,
  SPRINT_ENGINE_MODULE_ID,
  SPRINT_ENGINE_RUN_TARGET_KIND,
  SPRINT_ENGINE_PR_TARGET_KIND,
} from '../utils/sprintengineBacklogLinks'
import type { SprintEngineBacklogLinkOpenPorts } from '../utils/sprintengineBacklogLinks'
import type { ProxyTrackerIdentity } from '../utils/sprintengineTrackerSeeding'

// Lazy so the Sprint Engine board bundle only loads when the panel is actually
// rendered — never, when the module is disabled.
const SprintEngineBoardPanel = React.lazy(
  () => import('../components/panels/SprintEngineBoardPanel')
)

// The Sprints top-nav door and the full-page surface it opens (item 1763). Both
// lazy, and deliberately NOT top-level imports: the entry reaches the workspace
// store (and through it the FlexLayout graph), so keeping them behind a dynamic
// import leaves the eager module-registry graph store-free — the discipline the
// other module doors follow.
const SprintsNavEntry = React.lazy(() =>
  import('../components/workspace/globalSurface/sprints/SprintsNavEntry').then((module) => ({
    default: module.SprintsNavEntry,
  }))
)
const SprintsGlobalSurface = React.lazy(
  () => import('../components/workspace/globalSurface/sprints/SprintsGlobalSurface')
)

// The ports a Backlog `sprintengine.run` link opens through (item 1767). It used
// to find-or-mount a workspace for the run; the Sprints door reads runs from disk
// by state path, so opening one is now "open the door on it" — no workspace, no
// terminals, and a run whose workspace is long gone opens like any other.
//
// The run store is read once before opening, so a link pointing at a deleted or
// unreadable run reports that instead of silently opening the door on whatever
// the rail happens to lead with.
async function sprintEngineBacklogOpenPorts(): Promise<SprintEngineBacklogLinkOpenPorts> {
  const [{ useWorkspaceStore }, { publishDiagnostic }, { noteSprintDoorSelection }] = await Promise.all([
    import('../store/workspaceStore'),
    import('../utils/diagnostics'),
    import('../components/workspace/globalSurface/sprints/sprintDoorRequests'),
  ])
  return {
    openSprintsDoorOnRun: async (statePath: string): Promise<boolean> => {
      try {
        const projection = await window.api.readSprintEngineProjection(statePath)
        if (!projection.ok) return false
      } catch {
        return false
      }
      noteSprintDoorSelection(statePath)
      useWorkspaceStore.getState().openGlobalSurface('sprints')
      return true
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
      'Autonomous multi-agent sprint board with quality gates. Disabling hides the board, the Sprint and Design Wizard workspace modes, and stops the auto-run supervisor.',
    defaultEnabled: true,
    dependsOn: ['agent-runtime'],
  },
  registerRenderer(host) {
    host.registerPanel('sprintengine', SprintEngineBoardPanel)
    // The Sprints door at the order-20 slot the hardcoded WorkspaceSidebar row
    // used to hold (item 1763 / D4). That row toggled the Sprint Engines aside;
    // this routes the full page to the instance-global Sprints surface, so runs
    // stop being nested under one project. Registering here means the door and
    // its surface follow this module's enablement: switch Sprint Engine off and
    // both disappear, and a stale `activeGlobalSurface: 'sprints'` resolves to
    // null in WorkspaceManager's generic mount guard, falling back to the
    // workspace rather than painting a blank page.
    host.registerSidebarNavEntry({ id: 'sprints', order: 20, Component: SprintsNavEntry })
    host.registerGlobalSurface({ id: 'sprints', Component: SprintsGlobalSurface })
    // The `roadmap` board panel + the sidebar Roadmap door belong to the dedicated
    // `roadmap` module (MC-1691), and the `roadmap` workspace type was retired
    // (MC-1692) — Roadmap is an instance-global sidebar door now, not a per-project
    // workspace. So this only registers the Sprint Engine + Design Wizard types.
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
    // The pull request a completed sprint opened. A separate provider because a
    // PR is an opened GitHub artifact (open it in the browser), not a local run
    // store to mount/focus like a `sprintengine.run` link.
    host.registerBacklogLinkProvider({
      moduleId: SPRINT_ENGINE_MODULE_ID,
      targetKinds: [SPRINT_ENGINE_PR_TARGET_KIND],
      resolveLinkStatus: (input) => Promise.resolve(resolveSprintEnginePullRequestLink(input)),
      openLink: async (input) => {
        const url = input.link.target.url?.trim()
        if (!url) return false
        const result = await window.api.openExternal(url)
        return result.ok !== false
      },
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
      label: 'Run a Sprint',
      category: 'execute',
      order: 10,
      // On a multi-selection the one action acts on the whole selection
      // (MC-2060) — same entry point, selection-aware label, one sprint.
      getLabel: ({ selection }) =>
        selection && selection.items.length > 1
          ? `Start a sprint from these ${selection.items.length} items`
          : 'Run a Sprint',
      // An item already handed to an agent shows "Open agent" as its execute
      // action instead — running a fresh Sprint over work an agent already owns
      // would fork the effort, so the Sprint entry point drops out entirely.
      // A selection is eligible only when every member is (one linked or
      // terminal row would otherwise ride into the bundle silently).
      isVisible: ({ item, selection }) =>
        (selection?.items ?? [item]).every(
          (candidate) =>
            candidate.status !== 'archived'
            && candidate.status !== 'completed'
            && !hasSprintEngineRunLink(candidate)
            && !hasAgentLink(candidate),
        ),
      getState: ({ startSourcePlan }) => startSourcePlan ? 'enabled' : 'disabled',
      async run(context) {
        if (!context.startSourcePlan) return
        const startSourcePlan = context.startSourcePlan

        // A multi-selection seeds through the same sourceBundle seam an epic
        // launch uses: one bundle holding every selected item, epics expanded
        // to their open children (MC-2060). A selection of exactly one plain
        // item builds no plan here and falls through to the single-item flow
        // below, byte-identical to a plain right-click.
        if (context.selection) {
          const { buildBacklogSelectionSourcePlan } = await import(
            '../components/backlog/backlogSelectionSourcePlan'
          )
          const selectionPlan = buildBacklogSelectionSourcePlan({
            workspaceRoot: context.workspaceRoot,
            items: context.selection.items,
            projectItems: context.selection.projectItems,
          })
          if (selectionPlan) {
            startSourcePlan(selectionPlan)
            return
          }
        }

        let sourceContent = await context.readSource()

        // A proxy item mirrors a tracker issue. Backlog launches are reference-
        // mode, so the architect reads this file in place — refresh it from the
        // live issue first (T6 materialize upsert) so the run is seeded with the
        // current description + comments and the goal is the current issue title
        // (plan §3.6). A native item skips this entirely, keeping its seeding
        // byte-identical to today. Refresh failure falls back to the saved copy
        // with a visible notice — the launch is never blocked.
        const { parseProxyTrackerIdentity } = await import('../utils/sprintengineTrackerSeeding')
        const identity = parseProxyTrackerIdentity(sourceContent)
        if (identity) {
          const refreshed = await refreshProxyItemForSeed(context.workspaceRoot, identity)
          if (refreshed) sourceContent = await context.readSource()
        }

        const baseName = basename(context.item.relativePath).replace(/\.(md|html?)$/i, '')
        const teamName = slugifySprintEngineName(baseName)
        startSourcePlan({
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
      label: 'Open Sprint',
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

// Plain provider name for the fallback notice — never "provider"/"baseUrl" jargon.
function trackerProviderDisplayName(provider: ProxyTrackerIdentity['provider']): string {
  return provider === 'github' ? 'GitHub' : provider === 'jira' ? 'Jira' : 'Linear'
}

// Refresh a proxy item's on-disk file from its live tracker issue at seed time,
// through the shared T6 materialize upsert (which rewrites only tracker-owned
// body and preserves the Multicode-owned frontmatter + sidecar). Returns true
// when the file was refreshed, so the caller re-reads it for the fresh seed.
// Any failure (removed connection, dead token, offline, rate limit) resolves to
// false WITH a visible notice: the sprint still starts from the saved copy —
// never a blocked launch (plan §3.6, fallback discipline).
async function refreshProxyItemForSeed(
  workspaceRoot: string,
  identity: ProxyTrackerIdentity,
): Promise<boolean> {
  let reason = 'unavailable'
  try {
    const result = await window.api.trackerMaterialize({
      workspaceRoot,
      connectionId: identity.connectionId,
      externalIds: [identity.externalId],
    })
    if (result.ok) {
      const failure = result.failed.find((entry) => entry.externalId === identity.externalId)
      if (!failure) return true
      reason = failure.reason.trim() || 'unavailable'
    } else {
      reason = result.error.message.trim() || 'unavailable'
    }
  } catch (error) {
    reason = error instanceof Error ? error.message.trim() || 'unavailable' : 'unavailable'
  }
  const { publishDiagnosticSync } = await import('../utils/diagnostics')
  publishDiagnosticSync({
    level: 'warning',
    source: 'sprintengine',
    title: 'Started from the saved copy',
    message: `Couldn’t refresh ${identity.nativeKey || 'the issue'} from ${trackerProviderDisplayName(identity.provider)} (${reason}). The sprint starts from the last saved description and comments.`,
  })
  return false
}
