import React from 'react'

import type { RendererModule } from './renderer-host'
import { registerSprintEngineWorkspaceTypes } from './sprint-engine-workspace-types'
import { basename } from '../utils/paths'
import { slugifySprintEngineName } from '../utils/sprintengineStateFile'
import { markdownTitle } from '../components/workspace/newWorkspace/helpers'
import { SprintsGlyph, WorkflowsGlyph } from '../components/workspace/surfaceGlyphs'
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

// The Workflows door and its surface (item 2470): a SIBLING of Sprints, not a
// second copy of it. Both entries and both surfaces are the same two components
// parameterised by a door definition — what differs between the doors is the run
// partition they filter with and the words they use, and both of those are data.
const WorkflowsNavEntry = React.lazy(() =>
  import('../components/workspace/globalSurface/sprints/WorkflowsNavEntry').then((module) => ({
    default: module.WorkflowsNavEntry,
  }))
)
const WorkflowsGlobalSurface = React.lazy(
  () => import('../components/workspace/globalSurface/sprints/WorkflowsGlobalSurface')
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
  const [
    { useWorkspaceStore },
    { publishDiagnostic },
    { noteSprintDoorSelection },
    { runDoorForProjection },
    { normalizeSprintEngineProjection },
  ] = await Promise.all([
    import('../store/workspaceStore'),
    import('../utils/diagnostics'),
    import('../components/workspace/globalSurface/sprints/sprintDoorRequests'),
    import('../components/workspace/globalSurface/sprints/runDoors'),
    import('../utils/sprintengine'),
  ])
  return {
    openSprintsDoorOnRun: async (statePath: string): Promise<boolean> => {
      // The projection is read before opening anything, so a link pointing at a
      // deleted or unreadable run reports that rather than silently opening a
      // door on whatever its rail leads with. Since item 2470 the same read also
      // decides WHICH door: a link that named "sprints" still resolves, but it
      // resolves to the door the run is actually listed in — opening the other
      // one would show a rail its own partition keeps the run out of. A run
      // whose projection will not normalize takes the partition's own fallback,
      // which is Sprints.
      let state: ReturnType<typeof normalizeSprintEngineProjection> = null
      try {
        const projection = await window.api.readSprintEngineProjection(statePath)
        if (!projection.ok) return false
        state = normalizeSprintEngineProjection(projection.data)
      } catch {
        return false
      }
      const door = runDoorForProjection(state)
      noteSprintDoorSelection(statePath)
      useWorkspaceStore.getState().openGlobalSurface(door)
      return true
    },
    publishDiagnostic,
  }
}

// Sprint Engine renderer module. Matches the main-side `sprint-engine` module id
// so the single enablement override gates both processes consistently.
//
// Scope: this gates the user-facing Sprint Engine surfaces — the board panel,
// the `sprintengine` workspace mode, and the always-mounted auto-run supervisor
// + state synchronizer. The Sprint Engine
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
      'Autonomous multi-agent sprint board with quality gates. Disabling hides the board and the Sprint workspace mode, and stops the auto-run supervisor.',
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
    // Workflows sits beside Sprints (item 2470, owner ruling R7). One noun named
    // two jobs — turning a goal into a plan, and running a plan that already
    // exists — so there are two doors, each listing only its own runs. The order
    // puts Workflows first because it is where a goal starts.
    host.registerSidebarNavEntry({ id: 'workflows', order: 19, Component: WorkflowsNavEntry })
    // The door names itself (label + glyph) even though its drawer row is drawn
    // by SprintsNavEntry above: the Extensions home's Sprints tile is built from
    // the registry like the other four, and a shell that hard-coded "Sprints"
    // and a frond for it would be naming one module's surface on its behalf
    // (Extensions drawer ruling, 2026-09-05, Stage 3). The nav entry still owns
    // the ROW — its status dot and its wider reading of "selected" — which is
    // why the drawer keeps rendering that rather than a generic row.
    host.registerGlobalSurface({
      id: 'sprints',
      label: 'Sprints',
      Icon: SprintsGlyph,
      Component: SprintsGlobalSurface,
    })
    host.registerGlobalSurface({
      id: 'workflows',
      label: 'Workflows',
      Icon: WorkflowsGlyph,
      Component: WorkflowsGlobalSurface,
    })
    // Only the Sprint Engine workspace type. The `roadmap` type retired with its
    // door (MC-1692, deleted 2026-09-05) and was never registered here.
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
      // An item already handed to an agent is withheld: running a fresh Sprint
      // over work an agent already owns would fork the effort, so this entry
      // point drops out entirely. "Open agent" is the shell's own header
      // control for that case, not a module action.
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

        // Backlog launches are reference-mode: the architect reads this file in
        // place. There is no proxy-refresh step any more — MC-2361 removed
        // mirrored tracker items and MC-2363 removed the tracker layer itself,
        // so a backlog file is always its own canonical source.
        const sourceContent = await context.readSource()

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
