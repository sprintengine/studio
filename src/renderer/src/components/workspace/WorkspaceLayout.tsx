import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import {
  Actions,
  Layout,
  Model,
  TabNode,
  TabSetNode,
  type Action,
  type ITabRenderValues,
  type NodeMouseEvent,
} from 'flexlayout-react'
// combined.css carries the structural FlexLayout CSS — its theme color
// variables are scoped under `.flexlayout__theme_*` classes that we never
// apply. Our own `.flexlayout__layout { --color-*: var(--bg-*) }` block in
// src/renderer/src/assets/index.css drives every color, so the FlexLayout
// chrome follows our data-theme on Dark / Light / Slate / Dark Conifer.
// The previous `style/dark.css` import declared its own `.flexlayout__layout`
// rule with hardcoded dark color variables that painted over our theme
// tokens on every non-dark theme — the dark horizontal bars in light mode.
import 'flexlayout-react/style/combined.css'
import { getSpecialistAction } from '../../specialists/specialistActions'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { openExternalFileWindow } from '../auxWindows/openFileWindow'
import { getRendererHost, selectModuleEnabled } from '../../modules'
import {
  isSessionFailed,
  isSessionWorking,
  pickAgentTabRecency,
  pickTerminalTabRecency,
  tabRecencyLabel,
  useTerminalSessions,
} from '../../hooks/useTerminalSessions'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import { formatRelativeMs, formatRelativeMsAgo } from '../../utils/relativeTime'
import type { AgentCli, FuturePlanWorkspaceSource, HighlightColor, SprintEngineRole, SprintEngineRuntimeAgentStatus, Workspace } from '../../types/workspace'
import { captureNavRailWidthFraction, consumePendingAgentFlash, deleteTabPreservingNavRail, registerModel, restoreNavRailWidthFraction, unregisterModel } from '../../utils/modelRegistry'
import { TAB_DRAG_MIME, serializeTabDragPayload } from '../../utils/tabDragPayload'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { applySprintEngineAutomationStopReason } from '../../utils/sprintengineSupervisorNotifications'
import { HIGHLIGHT_COLORS, getHighlightSwatch } from '../../utils/highlight'
import { resolveWorkspaceWorktree } from '../../utils/workspaceWorktree'
import { SpecialistActionIcon, SprintEngineRoleIcon, WorkspaceTypeIcon } from '../AppIcons'
import WorkspaceLauncher from './WorkspaceLauncher'
import CliIcon from '../CliIcon'
import { AgentTabIdentityPopover, type AgentTabIdentity } from './AgentTabIdentityPopover'
import type { AgentCliCatalogOption } from './newWorkspace/cliRuntimeOptions'
import { labelForCliRuntime } from './newWorkspace/cliRuntimeOptions'
import { panelTabAccentClass } from './panelTabAccent'
import { LifecycleGlyph, type LifecycleState, StatusDot, type Tone } from '../ui'
import MulticodeSpinner from '../brand/MulticodeSpinner'
import AgentPanel from '../panels/AgentPanel'

interface Props {
  workspaceId: string
  onStartFuturePlan?: (source: FuturePlanWorkspaceSource) => void
  // Empty-workspace launcher inputs: the CLI quick-launch grid and the two
  // secondary launch paths (specialist picker, Sprint Engine setup).
  agentClis?: AgentCliCatalogOption[]
  onSpawnAgent?: (cli: AgentCli, label: string) => void
  // Renders the shared agent picker (AgentComposerPopover) as Popover content,
  // anchored to the launcher's row; `close` dismisses the popover after a pick.
  renderSpecialistPicker?: (close: () => void) => React.ReactNode
  onStartSprintEngine?: () => void
  onNewWorkspace?: () => void
  onCloseWorkspace?: (workspaceId: string) => void
}

// Count the live tabs in a model. A workspace whose last tab was closed leaves
// FlexLayout with an empty grid (sometimes empty tabsets), so we look for real
// TabNodes rather than trusting tabset presence.
function countOpenTabs(model: Model | null): number {
  if (!model) return 0
  let count = 0
  model.visitNodes((node) => {
    if (node instanceof TabNode) count += 1
  })
  return count
}

// Dev Tools panels. The canonical `editor` and `content-search` panels are
// served through the renderer host (gated on the dev-tools module). These local
// lazy consts back the panels that take extra props the host contract omits:
// `file-editor` (a per-file editor with a `filePath`) and `explorer`
// (`onStartFuturePlan`). They share the editor/explorer chunks with the
// host-served panels, so a disabled dev-tools module ships none of them.
const EditorPanel = React.lazy(() => import('../panels/EditorPanel'))
const FileExplorer = React.lazy(() => import('../panels/FileExplorer'))
const GitConflictResolverPanel = React.lazy(() => import('../panels/GitConflictResolverPanel'))
const PlainTerminalPanel = React.lazy(() => import('../panels/PlainTerminalPanel'))
// Local lazy const for the defensive fixed-view fallbacks below; the canonical
// 'sprintengine' board is served through the renderer host (gated). Both resolve
// to the same chunk, so a disabled Sprint Engine module ships neither.
const SprintEngineBoardPanel = React.lazy(() => import('../panels/SprintEngineBoardPanel'))
// Lazy so the run-summary / plan-reader bundles only load with their tabs — and
// never when Sprint Engine is disabled. They stay local (not host-registered)
// because they take an onClose callback the generic host panel contract omits.
const SprintEngineRunSummaryPanel = React.lazy(() => import('../panels/SprintEngineRunSummaryPanel'))
const SprintEnginePlanReaderPanel = React.lazy(() => import('../panels/SprintEnginePlanReaderPanel'))
const GuidedBriefWorkspacePanel = React.lazy(() => import('./guidedBrief/GuidedBriefWorkspacePanel'))
// Shown when a host panel can't render because its owning module is disabled or
// the layout tab is stale/unknown. An explicit, labeled unavailable state —
// never a silently blank surface — applied to every gated/stale arm below.
const DISABLED_SURFACE = (
  <div
    role="note"
    aria-label="Panel unavailable"
    className="flex h-full flex-col items-center justify-center gap-1 bg-[color:var(--bg-app)] px-6 text-center"
  >
    <p className="text-[12px] font-medium text-[color:var(--text-strong)]">Panel unavailable</p>
    <p className="max-w-xs text-[11px] leading-5 text-[color:var(--text-muted)]">
      This view isn’t available right now. Its feature may be disabled, or the tab may be out of date.
    </p>
  </div>
)
const AGENT_TAB_NEEDS_INPUT_CLASS = 'agent-tab-needs-input'
const loadedPanelComponents = new Set<string>()
const SPRINTENGINE_ROLES: SprintEngineRole[] = [
  'architect',
  'product',
  'developer',
  'frontend',
  'ui_ux_reviewer',
  'tester',
  'security',
  'code_reviewer',
  'nuclear_reviewer',
  'spec_reviewer',
  'performance',
  'production_readiness_reviewer',
  'cross_platform',
]
const EMPTY_WORKSPACE_AGENTS: Workspace['agents'] = {}
const EMPTY_SPRINTENGINE_AGENTS: NonNullable<Workspace['sprintEngineState']>['sprintEngineAgents'] = {}
const EMPTY_OPEN_FILES: Workspace['editorState']['openFiles'] = []

type AgentTabActivityDot = {
  tone: Tone
  pulse: boolean
  label: string
}

// The tab status dot follows actual work rather than mere process residency.
// Priority: needs-input > working > failed. Idle sessions fall back to elapsed
// idle time, while Sprint and automation surfaces keep their lifecycle spinners.
function agentTabStatusDot(
  session: TerminalSessionSnapshot | undefined,
  runtimeStatus: SprintEngineRuntimeAgentStatus | undefined,
  currentTaskId: string | null | undefined
): AgentTabActivityDot | null {
  if (runtimeStatus === 'needs_input') {
    return {
      tone: 'warn',
      pulse: true,
      label: currentTaskId ? `Needs input on ${currentTaskId}` : 'Needs input',
    }
  }
  // A paused agent keeps a retained (frozen) snapshot with the process gone, so
  // it is stopped, not resting — distinguish it from a live idle tab (which has
  // no dot). "Paused" mirrors the AgentPanel footer's user-facing wording.
  if (session?.suspended) {
    return { tone: 'neutral', pulse: false, label: 'Paused' }
  }
  if (session?.processAlive && isSessionWorking(session)) {
    return { tone: 'good', pulse: true, label: 'Working' }
  }
  if (isSessionFailed(session)) {
    return { tone: 'error', pulse: false, label: 'Failed' }
  }
  return null
}

// sprint agents are supervised by a run, so their tab shows persistent
// run status (blocked / complete / idle) — NOT terminal recency, which is
// meaningless for a managed agent. The genuinely-working (`running`) state is
// handled separately as a pulsing green dot (see the working-dot branch below);
// the spinner is reserved for workspace runs and backlog items, never a live
// agent. This maps the remaining statuses to a LifecycleGlyph state.
function sprintEngineTabLifecycle(
  status: SprintEngineRuntimeAgentStatus | undefined
): { state: LifecycleState; live: boolean; label: string } | null {
  switch (status) {
    case 'needs_input':
      return { state: 'needs_input', live: false, label: 'Blocked — needs input' }
    case 'done':
      return { state: 'done', live: false, label: 'Complete' }
    case 'retired':
      return { state: 'done', live: false, label: 'Finished' }
    case 'idle':
      return { state: 'in_progress', live: false, label: 'Idle — waiting for work' }
    default:
      return null
  }
}

function inferSprintEngineRoleFromAgentId(agentId: string): SprintEngineRole | null {
  return SPRINTENGINE_ROLES.find((role) => agentId === role || agentId.startsWith(`${role}-`)) ?? null
}

function PanelLoadingFallback() {
  return (
    <div className="flex h-full items-center justify-center bg-[color:var(--bg-app)] text-[12px] font-mono text-[color:var(--text-subtle)]">
      <span className="flex items-center gap-3">
        <MulticodeSpinner className="h-8 w-8" />
        <span>Loading panel...</span>
      </span>
    </div>
  )
}

function TimedPanelLoad({
  component,
  startedAt,
  children,
}: {
  component: string
  startedAt: number
  children: React.ReactNode
}) {
  const initialStartedAtRef = useRef(startedAt)

  useEffect(() => {
    const firstLoad = !loadedPanelComponents.has(component)
    loadedPanelComponents.add(component)
    logPerfEvent('WorkspaceLayout', 'panel-load', {
      component,
      elapsedMs: Math.round(performance.now() - initialStartedAtRef.current),
      firstLoad,
    })
  }, [component])

  return <>{children}</>
}

function timedPanel(component: string, children: React.ReactNode) {
  return (
    <Suspense fallback={<PanelLoadingFallback />}>
      <TimedPanelLoad component={component} startedAt={performance.now()}>
        {children}
      </TimedPanelLoad>
    </Suspense>
  )
}

function renderTerminalRecencyIndicator(
  session: TerminalSessionSnapshot | undefined,
  now: number
): React.ReactNode {
  if (!session) return null
  // Active work gets the pulsing green dot. Idle sessions show elapsed idle
  // time instead, beginning at 1m; sub-minute recency renders blank.
  if (session.processAlive && isSessionWorking(session)) {
    return <StatusDot tone="good" pulse label="Working" className="ml-0.5" />
  }
  if (isSessionFailed(session)) {
    return <StatusDot tone="error" label="Failed" className="ml-0.5" />
  }
  const recency = pickTerminalTabRecency(session)
  if (!recency) return null
  const recencyText = formatRelativeMs(recency.at, now)
  if (!recencyText) return null
  const label = tabRecencyLabel(recency.source)
  return (
    <span
      className="ml-0.5 shrink-0 text-[10px] tabular-nums text-[color:var(--text-subtle)]"
      title={`${label} ${formatRelativeMsAgo(recency.at, now)} (${new Date(recency.at).toLocaleString()})`}
      aria-label={`${label} ${formatRelativeMsAgo(recency.at, now)}`}
    >
      {recencyText}
    </span>
  )
}

function WorkspaceLayout({ workspaceId, onStartFuturePlan, agentClis, onSpawnAgent, renderSpecialistPicker, onStartSprintEngine, onNewWorkspace, onCloseWorkspace }: Props) {
  const layoutModel = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.layoutModel)
  const workspaceAgents = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)?.agents ?? EMPTY_WORKSPACE_AGENTS
  )
  const sprintEngineAgents = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)?.sprintEngineState?.sprintEngineAgents ?? EMPTY_SPRINTENGINE_AGENTS
  )
  const editorOpenFiles = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)?.editorState?.openFiles ?? EMPTY_OPEN_FILES
  )
  const lastTerminalActivityAt = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)?.lastTerminalActivityAt ?? null
  )
  // Worktree-backed workspace (a sprint run worktree, or a worktree opened as a
  // workspace). The branch glyph is applied *per agent* on the tabs below, not
  // blanket across the workspace: an agent only earns the glyph when it is
  // actually running on the worktree (see the per-agent resolution in
  // `renderTab`). Selected as primitives so the panel doesn't re-render on
  // unrelated workspace churn.
  //   - `worktreeGitRoot`: absolute git root of the workspace's worktree (null
  //      when not worktree-backed). Used as the fallback cwd for the tooltip.
  //   - `isWorktreeOpenedWorkspace`: the whole folder *is* a worktree (opened via
  //      the Worktree manager). Every agent/terminal in it runs on the worktree,
  //      even though their `execution.mode` stays `current_workspace` (the cwd is
  //      never redirected because the folder already is the worktree).
  const worktreeGitRoot = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    return ws ? resolveWorkspaceWorktree(ws)?.gitRoot ?? null : null
  })
  const worktreeBranch = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    return ws ? resolveWorkspaceWorktree(ws)?.branch ?? null : null
  })
  const isWorktreeOpenedWorkspace = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    return Boolean(ws?.worktree)
  })
  const terminalSessions = useTerminalSessions()
  const now = useRelativeNow()
  const updateLayout = useWorkspaceStore((s) => s.updateLayout)
  const updateAgent = useWorkspaceStore((s) => s.updateAgent)
  const setActiveFile = useWorkspaceStore((s) => s.setActiveFile)
  const closeFile = useWorkspaceStore((s) => s.closeFile)
  // Keep a stable Model instance per workspace — re-creating it destroys drag/resize state
  const modelRef = useRef<Model | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const skipNextRenameCommitRef = useRef(false)
  const hideTabWithoutCleanupRef = useRef(new Set<string>())
  const killOnUnmountSessionIdsRef = useRef(new Set<string>())
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  if (!layoutModel) return null
  if (!modelRef.current) {
    modelRef.current = Model.fromJson(layoutModel)
    modelRef.current.doAction(Actions.updateModelAttributes({ tabEnableRename: false }))
  }

  useEffect(() => {
    logPerfEvent('WorkspaceLayout', 'workspace-layout-mounted', { workspaceId })
    return () => {
      logPerfEvent('WorkspaceLayout', 'workspace-layout-unmounted', { workspaceId })
    }
  }, [workspaceId])

  useEffect(() => {
    if (modelRef.current) {
      registerModel(workspaceId, modelRef.current)
      // Drain a flash latched by a cross-workspace "Open agent" before this
      // workspace's Model existed, now that it is registered.
      consumePendingAgentFlash(workspaceId)
    }
    return () => unregisterModel(workspaceId)
  }, [workspaceId])

  useEffect(() => {
    if (!renamingTabId) return

    const input = renameInputRef.current
    if (!input) return

    input.focus()
    const caretPosition = input.value.length
    input.setSelectionRange(caretPosition, caretPosition)
  }, [renamingTabId])

  const shouldKillTerminalOnUnmount = useCallback((sessionId: string) => {
    const shouldKill = killOnUnmountSessionIdsRef.current.has(sessionId)
    if (shouldKill) killOnUnmountSessionIdsRef.current.delete(sessionId)
    return shouldKill
  }, [])

  const startRename = useCallback((event: React.MouseEvent, node: TabNode) => {
    event.preventDefault()
    event.stopPropagation()
    skipNextRenameCommitRef.current = false
    setRenamingTabId(node.getId())
    setRenameValue(node.getName())
  }, [])

  const commitRename = useCallback(() => {
    if (!renamingTabId) return

    if (skipNextRenameCommitRef.current) {
      skipNextRenameCommitRef.current = false
      setRenamingTabId(null)
      return
    }

    const nextName = renameValue.trim()
    const model = modelRef.current
    const node = model?.getNodeById(renamingTabId)

    if (nextName && node instanceof TabNode) {
      model?.doAction(Actions.renameTab(node.getId(), nextName))

      if (node.getComponent() === 'agent') {
        const config = node.getConfig() as { agentId?: string } | undefined
        updateAgent(workspaceId, config?.agentId ?? node.getId(), { name: nextName })
      }
    }

    setRenamingTabId(null)
  }, [renameValue, renamingTabId, updateAgent, workspaceId])

  useEffect(() => {
    const model = modelRef.current
    if (!model) return

    model.visitNodes((node) => {
      if (!(node instanceof TabNode)) return

      if (node.getComponent() === 'switchboard-board' && node.getName() === 'Board') {
        model.doAction(Actions.renameTab(node.getId(), 'Switchboard'))
        return
      }

      if (node.getComponent() !== 'agent') return

      const config = node.getConfig() as { agentId?: string } | undefined
      const agentId = config?.agentId ?? node.getId()
      const agent = workspaceAgents[agentId]
      const currentClassName = node.getClassName() ?? ''
      const classNames = currentClassName.split(/\s+/).filter(Boolean)
      const needsInput = sprintEngineAgents[agentId]?.status === 'needs_input'
      const nextClassNames = classNames.filter((className) => className !== AGENT_TAB_NEEDS_INPUT_CLASS)
      if (agent?.name && node.getName() !== agent.name) {
        model.doAction(Actions.renameTab(node.getId(), agent.name))
      }

      if (needsInput) {
        nextClassNames.push(AGENT_TAB_NEEDS_INPUT_CLASS)
      }

      const nextClassName = Array.from(new Set(nextClassNames)).join(' ')
      if (nextClassName !== currentClassName) {
        model.doAction(Actions.updateNodeAttributes(node.getId(), {
          className: nextClassName,
        }))
      }
    })
  }, [workspaceAgents, sprintEngineAgents])

  // Capability-module gate. Host-registered panels (editor, git, sprintengine,
  // switchboard, multiloop, memory-graph, …) are gated generically in the
  // factory's default case by their owning module's enablement, so a disabled
  // module's panel falls back to the explicit DISABLED_SURFACE and PanelRail
  // hides its button. Only the panels with bespoke props (file-editor, explorer, the
  // sprintengine fixed-view/summary fallbacks, guided-brief, git-conflict) need
  // an explicit gated arm below; those read enablement from this single
  // overrides object.
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)

  const factory = useCallback(
    (node: TabNode) => {
      const component = node.getComponent()
      const devToolsEnabled = selectModuleEnabled(moduleOverrides, 'dev-tools')
      const gitEnabled = selectModuleEnabled(moduleOverrides, 'git')
      const sprintEngineEnabled = selectModuleEnabled(moduleOverrides, 'sprint-engine')
      const config = node.getConfig() as {
        agentId?: string
        terminalId?: string
        filePath?: string
        repoRoot?: string
        checkForUpdatesRequestId?: number
        initialTab?: string
        highlightColor?: HighlightColor
        executionId?: string
        workspaceRoot?: string
        role?: string
        title?: string
        sessionId?: string
      } | undefined

      const wrapWithHighlight = (children: React.ReactNode): React.ReactNode => {
        if (component !== 'terminal' || !config?.highlightColor) return children
        const swatch = getHighlightSwatch(config.highlightColor)
        return (
          <div
            className="relative h-full w-full"
            style={{ boxShadow: `inset 0 0 0 1px ${swatch.hex}` }}
          >
            {children}
          </div>
        )
      }

      // Arms below are only for components the host can't serve generically:
      // always-on chrome (agent, terminal) and panels that take bespoke props
      // (file-editor's filePath, explorer's onStartFuturePlan, git-conflict's
      // paths, the sprintengine fixed-view/summary fallbacks, guided-brief).
      // Every plain `{ workspaceId }` host panel — editor, content-search, git,
      // sprintengine, multiloop-board, switchboard-*, memory-graph — falls
      // through to `default`, which renders it gated by its owning module.
      switch (component) {
        case 'agent':
          return (
            <AgentPanel
              workspaceId={workspaceId}
              agentId={config?.agentId ?? node.getId()}
              sessionId={config?.sessionId}
              shouldKillTerminalOnUnmount={shouldKillTerminalOnUnmount}
            />
          )
        case 'file-editor':
          return devToolsEnabled && config?.filePath
            ? timedPanel('EditorPanel', <EditorPanel workspaceId={workspaceId} filePath={config.filePath} />)
            : DISABLED_SURFACE
        case 'explorer':
          return devToolsEnabled
            ? timedPanel('FileExplorer', <FileExplorer workspaceId={workspaceId} onStartFuturePlan={onStartFuturePlan} />)
            : DISABLED_SURFACE
        case 'git-conflict':
          return gitEnabled && config?.repoRoot && config.filePath
            ? timedPanel('GitConflictResolverPanel', (
              <GitConflictResolverPanel
                workspaceId={workspaceId}
                repoRoot={config.repoRoot}
                filePath={config.filePath}
              />
            ))
            : DISABLED_SURFACE
        case 'terminal':
          return wrapWithHighlight(timedPanel('PlainTerminalPanel', (
            <PlainTerminalPanel
              workspaceId={workspaceId}
              terminalId={config?.terminalId ?? node.getId()}
              shouldKillOnUnmount={shouldKillTerminalOnUnmount}
            />
          )))
        // Defensive fallbacks for stale layouts that escaped migration — the
        // canonical layout now uses a single 'sprintengine' tab whose internal
        // segmented chrome covers all three views.
        case 'sprintengine-inbox':
          return sprintEngineEnabled
            ? timedPanel('SprintEngineBoardPanel', <SprintEngineBoardPanel workspaceId={workspaceId} fixedView="inbox" />)
            : DISABLED_SURFACE
        case 'sprintengine-roster':
          return sprintEngineEnabled
            ? timedPanel('SprintEngineBoardPanel', <SprintEngineBoardPanel workspaceId={workspaceId} fixedView="roster" />)
            : DISABLED_SURFACE
        case 'sprintengine-tasks':
          return sprintEngineEnabled
            ? timedPanel('SprintEngineBoardPanel', <SprintEngineBoardPanel workspaceId={workspaceId} fixedView="tasks" />)
            : DISABLED_SURFACE
        case 'guided-brief':
          // Guided Brief hands its build off to a Sprint Engine run, so it
          // follows sprint-engine enablement: a stale guided-brief workspace
          // shows the explicit unavailable surface when Sprint Engine is
          // disabled, matching the other modes.
          return sprintEngineEnabled
            ? timedPanel(
              'GuidedBriefWorkspacePanel',
              <GuidedBriefWorkspacePanel workspaceId={workspaceId} />
            )
            : DISABLED_SURFACE
        case 'sprintengine-run-summary':
          return sprintEngineEnabled
            ? timedPanel('SprintEngineRunSummaryPanel', (
              <SprintEngineRunSummaryPanel
                workspaceId={workspaceId}
                onClose={() => {
                  const model = modelRef.current
                  if (model) deleteTabPreservingNavRail(model, node.getId())
                }}
              />
            ))
            : DISABLED_SURFACE
        case 'sprintengine-plan-reader':
          return sprintEngineEnabled
            ? timedPanel('SprintEnginePlanReaderPanel', (
              <SprintEnginePlanReaderPanel
                workspaceId={workspaceId}
                onClose={() => {
                  const model = modelRef.current
                  if (model) deleteTabPreservingNavRail(model, node.getId())
                }}
              />
            ))
            : DISABLED_SURFACE
        default: {
          // Host-registered panels: render the registered component gated by its
          // owning module's enablement. A disabled module (or an unknown/stale
          // component) falls back to the explicit unavailable surface.
          const host = getRendererHost()
          const Panel = component ? host.getPanel(component) : undefined
          if (!Panel) return DISABLED_SURFACE
          const moduleId = host.getPanelModule(component!)
          if (moduleId && !selectModuleEnabled(moduleOverrides, moduleId)) return DISABLED_SURFACE
          return timedPanel(component!, <Panel workspaceId={workspaceId} onStartFuturePlan={onStartFuturePlan} />)
        }
      }
    },
    [moduleOverrides, onStartFuturePlan, shouldKillTerminalOnUnmount, workspaceId]
  )

  const cleanupNode = useCallback(
    (node: TabNode) => {
      const config = node.getConfig() as { agentId?: string; sessionId?: string; terminalId?: string; filePath?: string } | undefined
      if (node.getComponent() === 'file-editor') {
        if (config?.filePath) closeFile(workspaceId, config.filePath)
        return
      }

      if (node.getComponent() === 'agent') {
        const agentId = config?.agentId ?? node.getId()
        const agent = workspaceAgents[agentId]
        const sessionIds = new Set<string>()
        if (config?.sessionId) sessionIds.add(config.sessionId)
        if (agent?.cliSessionId) sessionIds.add(agent.cliSessionId)
        terminalSessions
          .filter((session) =>
            session.kind === 'agent'
            && session.workspaceId === workspaceId
            && session.agentId === agentId
          )
          .forEach((session) => sessionIds.add(session.sessionId))
        sessionIds.forEach((sessionId) => {
          killOnUnmountSessionIdsRef.current.add(sessionId)
          void window.api.terminalKill(sessionId).catch(() => {})
        })
        if (agent) {
          if (agent.kind === 'sprintengine') {
            applySprintEngineAutomationStopReason(workspaceId, 'agent_terminal_closed', { agentId })
          }
          updateAgent(workspaceId, agentId, {
            cliStartRequested: false,
            cliHasLaunched: false,
            cliOnboardingPromptSent: false,
            cliResumeAvailable: false,
            cliSessionId: undefined,
          })
        }
        return
      }

      if (node.getComponent() === 'terminal') {
        const terminalId = config?.terminalId ?? node.getId()
        const sessionIds = new Set<string>([`terminal-${terminalId}`])
        terminalSessions
          .filter((session) =>
            session.kind === 'terminal'
            && session.workspaceId === workspaceId
            && session.terminalId === terminalId
          )
          .forEach((session) => sessionIds.add(session.sessionId))
        sessionIds.forEach((sessionId) => {
          killOnUnmountSessionIdsRef.current.add(sessionId)
          void window.api.terminalKill(sessionId).catch(() => {})
        })
      }
    },
    [closeFile, terminalSessions, updateAgent, workspaceAgents, workspaceId]
  )

  const handleAction = useCallback(
    (action: Action) => {
      // Removing a tabset hands its weight back to flexlayout, which spreads it
      // across every remaining sibling — including the strip-less Files/Git/
      // Backlog nav rail, which would otherwise grow when a terminal beside it
      // is closed. Snapshot the rail's width before the deletion applies, then
      // re-pin it once the model has settled so the freed space goes to the
      // editor/terminal siblings instead.
      if (action.type === Actions.DELETE_TAB || action.type === Actions.DELETE_TABSET) {
        const model = modelRef.current
        const navFraction = model ? captureNavRailWidthFraction(model) : null
        if (navFraction != null) {
          queueMicrotask(() => {
            const current = modelRef.current
            if (current) restoreNavRailWidthFraction(current, navFraction)
          })
        }
      }

      if (action.type === Actions.DELETE_TAB) {
        const node = modelRef.current?.getNodeById(action.data.node)
        const nodeId = node?.getId() ?? String(action.data.node ?? '')
        const preserveRuntime = (action.data as Record<string, unknown>).__multicodePreserveRuntime === true
        if (preserveRuntime) {
          hideTabWithoutCleanupRef.current.delete(nodeId)
        } else if (hideTabWithoutCleanupRef.current.has(nodeId)) {
          hideTabWithoutCleanupRef.current.delete(nodeId)
        } else if (node instanceof TabNode) {
          cleanupNode(node)
        }
      }

      if (action.type === Actions.SELECT_TAB) {
        const node = modelRef.current?.getNodeById(action.data.tabNode)
        if (node instanceof TabNode && node.getComponent() === 'file-editor') {
          const config = node.getConfig() as { filePath?: string } | undefined
          if (config?.filePath) setActiveFile(workspaceId, config.filePath)
        }
      }

      if (action.type === Actions.RENAME_TAB) {
        const node = modelRef.current?.getNodeById(action.data.node)
        if (node instanceof TabNode && node.getComponent() === 'agent') {
          const config = node.getConfig() as { agentId?: string } | undefined
          const agentId = config?.agentId ?? node.getId()
          const nextName = String(action.data.text ?? '').trim()
          if (nextName) updateAgent(workspaceId, agentId, { name: nextName })
        }
      }

      if (action.type === Actions.DELETE_TABSET) {
        const node = modelRef.current?.getNodeById(action.data.node)
        if (node instanceof TabSetNode) {
          node.getChildren().forEach((child) => {
            if (child instanceof TabNode && child.isEnableClose()) {
              cleanupNode(child)
            }
          })
        }
      }

      return action
    },
    [cleanupNode, setActiveFile, updateAgent, workspaceId]
  )

  const closeTabWithCleanup = useCallback((node: TabNode) => {
    cleanupNode(node)
    const model = modelRef.current
    if (model) deleteTabPreservingNavRail(model, node.getId())
  }, [cleanupNode])

  const handleAuxMouseClick = useCallback<NodeMouseEvent>((node, event) => {
    if (event.button !== 1 || !(node instanceof TabNode) || !node.isEnableClose()) return

    event.preventDefault()
    event.stopPropagation()
    closeTabWithCleanup(node)
  }, [closeTabWithCleanup])

  const findTabNodeFromElement = useCallback((element: Element): TabNode | null => {
    const tabButton = element.closest<HTMLElement>('.flexlayout__tab_button')
    const tabPath = tabButton?.getAttribute('data-layout-path')
    const model = modelRef.current
    if (!tabPath || !model) return null

    let result: TabNode | null = null
    model.visitNodes((node) => {
      if (result || !(node instanceof TabNode)) return
      if (node.getPath() === tabPath) result = node
    })
    return result
  }, [])

  const handleMouseDownCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 1) return
    if (!(event.target instanceof Element)) return

    const node = findTabNodeFromElement(event.target)
    if (!node || !node.isEnableClose()) return
    event.preventDefault()
    event.stopPropagation()
    closeTabWithCleanup(node)
  }, [closeTabWithCleanup, findTabNodeFromElement])

  const closeOtherTabsInSet = useCallback((node: TabNode) => {
    const parent = node.getParent()
    if (!(parent instanceof TabSetNode)) return

    parent.getChildren().forEach((child) => {
      if (!(child instanceof TabNode) || child.getId() === node.getId() || !child.isEnableClose()) return
      closeTabWithCleanup(child)
    })
  }, [closeTabWithCleanup])

  const hideAllAgentTabs = useCallback(() => {
    const model = modelRef.current
    if (!model) return
    const agentNodeIds: string[] = []
    model.visitNodes((candidate) => {
      if (candidate instanceof TabNode && candidate.getComponent() === 'agent') {
        agentNodeIds.push(candidate.getId())
      }
    })
    agentNodeIds.forEach((nodeId) => {
      hideTabWithoutCleanupRef.current.add(nodeId)
      deleteTabPreservingNavRail(model, nodeId)
    })
  }, [])

  const hideTab = useCallback((node: TabNode) => {
    if (node.getComponent() !== 'agent') return
    hideTabWithoutCleanupRef.current.add(node.getId())
    const parent = node.getParent()
    const model = modelRef.current
    if (model) deleteTabPreservingNavRail(model, node.getId())

    // The hide button is removed with the tab, leaving focus on <body>; hand it back to the new active tab.
    if (!(parent instanceof TabSetNode)) return
    const parentPath = parent.getPath()
    requestAnimationFrame(() => {
      const escapedPath = parentPath.replace(/"/gu, '\\"')
      const tabsetEl = document.querySelector<HTMLElement>(`[data-layout-path="${escapedPath}"]`)
      const nextActive = tabsetEl?.querySelector<HTMLElement>('.flexlayout__tab_button--selected')
        ?? tabsetEl?.querySelector<HTMLElement>('.flexlayout__tab_button')
      nextActive?.focus()
    })
  }, [])

  const showTabContextMenu = useCallback(async (event: React.MouseEvent, node: TabNode) => {
    event.preventDefault()
    event.stopPropagation()

    const parent = node.getParent()
    const otherClosableTabs = parent instanceof TabSetNode
      ? parent.getChildren().filter((child) => child instanceof TabNode && child.getId() !== node.getId() && child.isEnableClose())
      : []

    let agentTabCount = 0
    modelRef.current?.visitNodes((candidate) => {
      if (candidate instanceof TabNode && candidate.getComponent() === 'agent') agentTabCount += 1
    })

    const isTerminal = node.getComponent() === 'terminal'
    const config = node.getConfig() as { highlightColor?: HighlightColor } | undefined
    const currentColor = config?.highlightColor ?? null

    const colorSubmenu = HIGHLIGHT_COLORS.map((color) => ({
      id: `color:${color}`,
      label: getHighlightSwatch(color).label,
      type: 'checkbox' as const,
      checked: currentColor === color,
    }))

    const items = [
      { id: 'hide-tab', label: 'Hide Tab', enabled: node.getComponent() === 'agent' },
      { id: 'hide-all-tabs', label: 'Hide All', enabled: agentTabCount > 0 },
      { id: 'close-other-tabs', label: 'Close Other Tabs', enabled: otherClosableTabs.length > 0 },
      ...(isTerminal
        ? [
            { type: 'separator' as const },
            {
              label: 'Color',
              enabled: true,
              submenu: [
                ...colorSubmenu,
                { type: 'separator' as const },
                { id: 'color:none', label: 'Clear color', enabled: currentColor !== null },
              ],
            },
          ]
        : []),
    ]

    const command = await window.api.showContextMenu(items)

    if (command === 'hide-tab') {
      hideTab(node)
    }
    if (command === 'hide-all-tabs') {
      hideAllAgentTabs()
    }
    if (command === 'close-other-tabs') {
      closeOtherTabsInSet(node)
    }
    if (command?.startsWith('color:')) {
      const value = command.slice('color:'.length)
      const nextColor =
        value === 'none'
          ? undefined
          : (HIGHLIGHT_COLORS as readonly string[]).includes(value)
            ? (value as HighlightColor)
            : undefined
      const nextConfig = { ...(node.getConfig() ?? {}), highlightColor: nextColor }

      // Preserve any existing non-highlight class names on the tab while we
      // replace the tab-highlight-* class. Other classes here include
      // `agent-tab-needs-input`.
      const existingClassName = node.getClassName() ?? ''
      const baseClassNames = existingClassName
        .split(/\s+/u)
        .filter((cls) => cls && !cls.startsWith('tab-highlight-'))
      if (nextColor) baseClassNames.push(`tab-highlight-${nextColor}`)
      const nextClassName = baseClassNames.join(' ').trim() || undefined

      modelRef.current?.doAction(
        Actions.updateNodeAttributes(node.getId(), {
          config: nextConfig,
          className: nextClassName,
        })
      )
    }
  }, [closeOtherTabsInSet, hideAllAgentTabs, hideTab])

  const renderTab = useCallback(
    (node: TabNode, renderValues: ITabRenderValues) => {
      // Prepend a worktree branch glyph to a tab's leading slot (preserving any
      // role/specialist/highlight icon) when *this* tab is running on a worktree.
      // `wt` is the resolved worktree for the tab (null → no glyph); its `cwd` is
      // surfaced in the hover tooltip so the worktree's location is discoverable.
      const withWorktreeGlyph = (
        existing: React.ReactNode,
        wt: { cwd: string | null; branch: string | null } | null,
      ): React.ReactNode => {
        if (!wt) return existing
        const heading = wt.branch ? `Worktree · ${wt.branch}` : 'Running in a git worktree'
        const title = wt.cwd ? `${heading}\n${wt.cwd}` : heading
        const glyph = (
          <span
            className="flex h-4 w-3.5 shrink-0 items-center justify-center text-[color:var(--text-muted)]"
            title={title}
            aria-label={title}
          >
            <svg viewBox="0 0 16 16" className="icon-sm" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="4" cy="3" r="1.6" />
              <circle cx="4" cy="13" r="1.6" />
              <circle cx="12" cy="6" r="1.6" />
              <path d="M4 4.6v6.8M4 9.5a4 4 0 0 0 4-4 2.5 2.5 0 0 1 2.5-2.5" />
            </svg>
          </span>
        )
        return existing ? (
          <span className="flex shrink-0 items-center gap-1">{glyph}{existing}</span>
        ) : glyph
      }

      if (renamingTabId === node.getId()) {
        renderValues.content = (
          <input
            ref={renameInputRef}
            className="flexlayout__tab_button_textbox"
            type="text"
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onBlur={commitRename}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commitRename()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                skipNextRenameCommitRef.current = true
                event.currentTarget.blur()
                setRenamingTabId(null)
              }
              event.stopPropagation()
            }}
          />
        )
        return
      }

      const canRenameTab = node.getComponent() !== 'file-editor'
      const canDragOut = node.isEnableClose()
      const handleTabDragStart = canDragOut
        ? (event: React.DragEvent<HTMLSpanElement>) => {
            const rawConfig = node.getConfig()
            const payload = serializeTabDragPayload({
              sourceWorkspaceId: workspaceId,
              tabId: node.getId(),
              component: node.getComponent() ?? '',
              name: node.getName(),
              config:
                rawConfig && typeof rawConfig === 'object'
                  ? (rawConfig as Record<string, unknown>)
                  : null,
              className: node.getClassName() ?? null,
            })
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData(TAB_DRAG_MIME, payload)
            event.dataTransfer.setData('text/plain', node.getName())
          }
        : undefined
      // Dragging a file-editor tab out of the app window pops the file into the
      // external editor window and flips the sticky preference to pop-up mode.
      // Drops inside the window fall through to FlexLayout's own tab handling.
      const handleTabDragEnd = canDragOut && node.getComponent() === 'file-editor'
        ? (event: React.DragEvent<HTMLSpanElement>) => {
            const left = window.screenX
            const top = window.screenY
            const outside =
              event.screenX < left
              || event.screenX > left + window.outerWidth
              || event.screenY < top
              || event.screenY > top + window.outerHeight
            if (!outside) return
            const config = node.getConfig() as { filePath?: string } | undefined
            const filePath = config?.filePath
            if (!filePath) return
            void openExternalFileWindow({ workspaceId, path: filePath, name: node.getName() })
            useWorkspaceStore.getState().setOpenFilesInExternalWindow(true)
            deleteTabPreservingNavRail(node.getModel(), node.getId())
          }
        : undefined
      // A live PTY bolds the tab name, mirroring the sidebar's resident-workspace
      // bolding (font-semibold) so suspended/exited terminals read as the quieter
      // state. Covers plain terminals and agent terminals; editors and panels have
      // no liveness and stay normal weight. Uses the same session lookup the status
      // dot below uses, so weight and dot never disagree.
      const tabComponentId = node.getComponent()
      let liveTabSession: TerminalSessionSnapshot | undefined
      if (tabComponentId === 'terminal') {
        const cfg = node.getConfig() as { terminalId?: string } | undefined
        liveTabSession = terminalSessions.find(
          (s) => s.sessionId === `terminal-${cfg?.terminalId ?? node.getId()}`
        )
      } else if (tabComponentId === 'agent') {
        const cfg = node.getConfig() as { agentId?: string; sessionId?: string } | undefined
        const aId = cfg?.agentId ?? node.getId()
        const sId = cfg?.sessionId ?? workspaceAgents[aId]?.cliSessionId
        liveTabSession = sId ? terminalSessions.find((s) => s.sessionId === sId) : undefined
      }
      const isLiveTab = Boolean(liveTabSession?.processAlive)

      const tabContent = (
        <span
          className={`min-w-0 truncate ${isLiveTab ? 'font-semibold' : ''}`}
          draggable={canDragOut}
          onDragStart={handleTabDragStart}
          onDragEnd={handleTabDragEnd}
          onContextMenu={(event) => void showTabContextMenu(event, node)}
          onDoubleClick={canRenameTab ? (event) => startRename(event, node) : undefined}
        >
          {renderValues.content}
        </span>
      )

      if (node.getComponent() === 'file-editor') {
        const config = node.getConfig() as { filePath?: string } | undefined
        const file = editorOpenFiles.find((openFile) => openFile.path === config?.filePath)
        renderValues.content = (
          <span className="inline-flex min-w-0 items-center gap-1">
            {tabContent}
            {file?.isDirty && (
              <span className="shrink-0 text-[color:var(--tone-warn)]" aria-label="Unsaved changes" title="Unsaved changes">
                •
              </span>
            )}
          </span>
        )
        return
      }

      if (node.getComponent() !== 'agent') {
        const componentId = node.getComponent()
        if (componentId === 'terminal') {
          const config = node.getConfig() as { highlightColor?: HighlightColor; terminalId?: string } | undefined
          if (config?.highlightColor) {
            const swatch = getHighlightSwatch(config.highlightColor)
            renderValues.leading = (
              <span
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ backgroundColor: swatch.hex }}
                aria-label={`${swatch.label} terminal`}
                title={`${swatch.label} terminal`}
              />
            )
          }
          // A plain terminal only genuinely runs on the worktree when the whole
          // workspace folder *is* one (opened via the Worktree manager). In a
          // sprint run-worktree workspace the terminal runs in the parent
          // checkout, not the run worktree, so it gets no glyph.
          renderValues.leading = withWorktreeGlyph(
            renderValues.leading,
            isWorktreeOpenedWorkspace ? { cwd: worktreeGitRoot, branch: worktreeBranch } : null,
          )
          const terminalId = config?.terminalId ?? node.getId()
          const session = terminalSessions.find((s) => s.sessionId === `terminal-${terminalId}`)
          const indicator = renderTerminalRecencyIndicator(session, now)
          if (indicator) {
            renderValues.content = (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                {tabContent}
                {indicator}
              </span>
            )
            return
          }
        } else if (componentId === 'watchtower-panel' || componentId === 'switchboard-board') {
          const isWatchtower = componentId === 'watchtower-panel'
          // Degrade the panel-tab accent + icon to generic when the switchboard
          // module is disabled, matching the workspace tab/row contract (AC4).
          renderValues.leading = (
            <span
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] ${panelTabAccentClass(isWatchtower ? 'watchtower' : 'switchboard', moduleOverrides)}`}
              title={isWatchtower ? 'Watchtower panel' : 'Switchboard panel'}
              aria-label={isWatchtower ? 'Watchtower panel' : 'Switchboard panel'}
            >
              <WorkspaceTypeIcon mode="switchboard" moduleOverrides={moduleOverrides} className="h-3.5 w-3.5" />
            </span>
          )
        } else if (componentId?.startsWith('sprintengine')) {
          renderValues.leading = (
            <span
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] ${panelTabAccentClass('sprintengine', moduleOverrides)}`}
              title='Sprint panel'
              aria-label='Sprint panel'
            >
              <WorkspaceTypeIcon mode="sprintengine" moduleOverrides={moduleOverrides} className="h-3.5 w-3.5" />
            </span>
          )
        }
        renderValues.content = tabContent
        return
      }

      const config = node.getConfig() as { agentId?: string; sessionId?: string } | undefined
      const agentId = config?.agentId ?? node.getId()
      const agent = workspaceAgents[agentId]
      const agentSessionId = config?.sessionId ?? agent?.cliSessionId
      const runtimeAgent = sprintEngineAgents[agentId]
      const agentSession = agentSessionId
        ? terminalSessions.find((s) => s.sessionId === agentSessionId)
        : undefined
      const currentTaskId = runtimeAgent?.currentTaskId
      const isWorking = Boolean(agentSession?.processAlive && isSessionWorking(agentSession))
      // sprint agents show their run lifecycle (in progress / blocked /
      // complete), never a live dot or recency. Everyone else uses the
      // working dot with recency while idle.
      const isSprintEngineRun = agent?.kind === 'sprintengine'
      const sprintEngineLifecycle = isSprintEngineRun
        ? sprintEngineTabLifecycle(runtimeAgent?.status)
        : null
      // A sprint agent that is genuinely running is "doing work" → pulsing green
      // dot, the same idiom every other working agent uses. Non-working sprint
      // statuses (blocked / complete / idle) fall through to their lifecycle
      // glyph above; everyone else uses the standard activity dot.
      const activityDot: AgentTabActivityDot | null = isSprintEngineRun
        ? (runtimeAgent?.status === 'running'
            ? { tone: 'good', pulse: true, label: 'Working' }
            : null)
        : agentTabStatusDot(agentSession, runtimeAgent?.status, currentTaskId)
      const specialist = (agent?.kind === 'specialist' || agent?.kind === 'watchtower') && agent.specialistId
        ? getSpecialistAction(agent.specialistId)
        : null
      const sprintEngineRole = agent?.kind === 'sprintengine'
        ? runtimeAgent?.role ?? inferSprintEngineRoleFromAgentId(agentId)
        : null
      const multiloopRole = agent?.kind === 'multiloop' ? agent.multiloopRole : null

      if (specialist) {
        renderValues.leading = (
          <span
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] text-[color:var(--text-muted)]"
            title={`${specialist.shortLabel} specialist`}
            aria-label={`${specialist.shortLabel} specialist`}
          >
            <SpecialistActionIcon icon={specialist.icon} className="h-3.5 w-3.5" />
          </span>
        )
      } else if (sprintEngineRole) {
        renderValues.leading = (
          <span
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px]"
            title={`${sprintEngineRole} sprint agent`}
            aria-label={`${sprintEngineRole} sprint agent`}
          >
            <SprintEngineRoleIcon role={sprintEngineRole} className="h-3.5 w-3.5" />
          </span>
        )
      } else if (multiloopRole) {
        renderValues.leading = (
          <span
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px]"
            title={`${multiloopRole} Multiloop agent`}
            aria-label={`${multiloopRole} Multiloop agent`}
          >
            <WorkspaceTypeIcon mode="multiloop" moduleOverrides={moduleOverrides} className="h-3.5 w-3.5" />
          </span>
        )
      } else if (agent?.cli) {
        // A plain agent has no role glyph, so its otherwise-empty leading slot
        // carries the runtime brand mark (Claude Code / Codex / OpenCode) — the
        // at-a-glance "which harness" signal. The exact model lives in the hover
        // popout, since models carry no icon.
        const runtimeLabel = `${labelForCliRuntime(agent.cli)} runtime`
        renderValues.leading = (
          <span
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] text-[color:var(--text-muted)]"
            title={runtimeLabel}
            aria-label={runtimeLabel}
          >
            <CliIcon cli={agent.cli} className="h-3.5 w-3.5" />
          </span>
        )
      } else {
        renderValues.leading = null
      }
      // Per-agent worktree glyph: an agent earns it only when it is actually
      // running on a worktree. Two ways that happens:
      //   1. The workspace folder itself is a worktree (opened via the Worktree
      //      manager) → every agent in it runs on the worktree, even though
      //      `execution.mode` stays `current_workspace` (cwd is never redirected).
      //   2. A sprint run-worktree agent whose `execution.mode === 'worktree'`
      //      and cwd points into the run worktree. A manually-spawned agent in
      //      the same workspace stays on the main checkout → no glyph.
      const agentWorktree: { cwd: string | null; branch: string | null } | null =
        !worktreeGitRoot
          ? null
          : isWorktreeOpenedWorkspace
            ? { cwd: worktreeGitRoot, branch: worktreeBranch }
            : agent?.execution.mode === 'worktree'
              ? { cwd: agent.execution.cwd ?? worktreeGitRoot, branch: worktreeBranch }
              : null
      renderValues.leading = withWorktreeGlyph(renderValues.leading, agentWorktree)

      // Recency only when NOT working and NOT a Sprint Engine run. Active agents
      // show the pulsing green dot; sprint agents show run lifecycle.
      const agentRecency = isWorking || isSprintEngineRun
        ? null
        : pickAgentTabRecency(
            agentSession,
            lastTerminalActivityAt,
            agent?.cliLastExitedAt
          )
      const agentRecencyText = agentRecency !== null
        ? formatRelativeMs(agentRecency.at, now)
        : ''
      const recencyIndicator = agentRecency !== null && agentRecencyText
        ? (
            <span
              className="ml-0.5 shrink-0 text-[10px] tabular-nums text-[color:var(--text-subtle)]"
              title={`${tabRecencyLabel(agentRecency.source)} ${formatRelativeMsAgo(agentRecency.at, now)} (${new Date(agentRecency.at).toLocaleString()})`}
              aria-label={`${tabRecencyLabel(agentRecency.source)} ${formatRelativeMsAgo(agentRecency.at, now)}`}
            >
              {agentRecencyText}
            </span>
          )
        : null

      // Trailing status treatment, shared across the three content branches:
      // sprint agents show a run-lifecycle glyph, everyone else the activity dot
      // (+ recency while idle).
      const trailing = sprintEngineLifecycle ? (
        <LifecycleGlyph
          state={sprintEngineLifecycle.state}
          live={sprintEngineLifecycle.live}
          label={sprintEngineLifecycle.label}
          className="translate-y-px"
        />
      ) : activityDot ? (
        <>
          <StatusDot tone={activityDot.tone} pulse={activityDot.pulse} label={activityDot.label} />
          {recencyIndicator}
        </>
      ) : (
        recencyIndicator
      )

      // Everything needed to identify this agent, surfaced in the hover/focus
      // popout wrapping the tab content. Role glyph stays the at-rest signal;
      // the popout carries the exact model, runtime, and session id.
      const prettyRole = (role: string): string =>
        role
          .split(/[-_\s]+/u)
          .filter(Boolean)
          .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
          .join(' ')
      const roleLabel = specialist
        ? `${specialist.shortLabel} specialist`
        : sprintEngineRole
          ? `${prettyRole(sprintEngineRole)} · sprint`
          : multiloopRole
            ? `${prettyRole(multiloopRole)} · multiloop`
            : 'General agent'
      // Paused wins its own self-contained label (with elapsed time) so the
      // popout reads "Paused · 13m" without leaning on the tab's recency chip.
      // Otherwise mirror the tab dot, then sprint lifecycle, then the honest
      // recency source (Idle / Last activity / Exited) — never a blanket "Idle".
      const identityStatus: AgentTabIdentity['status'] = agentSession?.suspended
        ? {
            tone: 'neutral',
            pulse: false,
            label: agentRecencyText ? `Paused · ${agentRecencyText}` : 'Paused',
          }
        : activityDot
          ? { tone: activityDot.tone, pulse: Boolean(activityDot.pulse), label: activityDot.label }
          : sprintEngineLifecycle
            ? {
                tone: sprintEngineLifecycle.state === 'needs_input' ? 'warn' : 'neutral',
                pulse: false,
                label: sprintEngineLifecycle.label,
              }
            : agentRecency !== null && agentRecencyText
              ? {
                  tone: 'neutral',
                  pulse: false,
                  label: `${tabRecencyLabel(agentRecency.source)} · ${agentRecencyText}`,
                }
              : { tone: 'neutral', pulse: false, label: 'Idle' }
      const agentIdentity: AgentTabIdentity = {
        name: agent?.name ?? node.getName(),
        roleLabel,
        model: agent?.cliModel ?? null,
        cli: agent?.cli ?? null,
        cliLabel: agent?.cli ? labelForCliRuntime(agent.cli) : null,
        sessionId: agentSessionId ?? null,
        taskId: currentTaskId ?? null,
        worktree: agentWorktree,
        status: identityStatus,
      }

      renderValues.content = (
        <AgentTabIdentityPopover identity={agentIdentity}>
          {tabContent}
          {trailing}
        </AgentTabIdentityPopover>
      )
    },
    [commitRename, editorOpenFiles, hideTab, isWorktreeOpenedWorkspace, lastTerminalActivityAt, moduleOverrides, now, renameValue, renamingTabId, showTabContextMenu, sprintEngineAgents, startRename, terminalSessions, workspaceAgents, worktreeBranch, worktreeGitRoot, workspaceId]
  )

  const handleContextMenu = useCallback<NodeMouseEvent>((node, event) => {
    if (!(node instanceof TabNode)) return
    event.preventDefault()
    event.stopPropagation()
    void showTabContextMenu(event, node)
  }, [showTabContextMenu])

  const isEmpty = countOpenTabs(modelRef.current) === 0

  return (
    <div className="relative h-full" onMouseDownCapture={handleMouseDownCapture}>
      <Layout
        model={modelRef.current}
        factory={factory}
        onAction={handleAction}
        onAuxMouseClick={handleAuxMouseClick}
        onContextMenu={handleContextMenu}
        onRenderTab={renderTab}
        onModelChange={(model) => {
          updateLayout(workspaceId, model.toJson())
        }}
      />
      {isEmpty ? (
        <WorkspaceLauncher
          agentClis={agentClis ?? []}
          onSpawnAgent={onSpawnAgent ?? (() => {})}
          renderSpecialistPicker={renderSpecialistPicker}
          onStartSprintEngine={onStartSprintEngine ?? (() => {})}
          onNewWorkspace={onNewWorkspace}
          onClose={onCloseWorkspace ? () => onCloseWorkspace(workspaceId) : undefined}
        />
      ) : null}
    </div>
  )
}

export default React.memo(WorkspaceLayout)
