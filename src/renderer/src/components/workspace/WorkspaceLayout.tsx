import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import {
  Actions,
  Layout,
  Model,
  TabNode,
  TabSetNode,
  type Action,
  type BorderNode,
  type ITabRenderValues,
  type ITabSetRenderValues,
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
import { FLEX_LAYOUT_ICONS } from './flexLayoutIcons'
import { getSpecialistAction } from '../../specialists/specialistActions'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { openExternalFileWindow } from '../auxWindows/openFileWindow'
import { getRendererHost, selectModuleEnabled } from '../../modules'
import { isModeHiddenFromRail } from '../../../../shared/workspace-mode'
import { EXTENSIONS_BROWSE_DEEPLINK } from '../settings/extensionsRoute'
import { MissingModulePanelSurface, ModuleNotInstalledSurface, moduleLabelForMode } from './ModuleAbsenceSurfaces'
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
import type { FuturePlanWorkspaceSource, HighlightColor, SprintEngineRuntimeAgentStatus, Workspace } from '../../types/workspace'
import { NEW_AGENT_TAB_COMPONENT, captureRailWidthFractions, consumePendingAgentFlash, deleteTabPreservingRails, registerModel, restoreRailWidthFractions, unregisterModel } from '../../utils/modelRegistry'
import { TAB_DRAG_MIME, serializeTabDragPayload } from '../../utils/tabDragPayload'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { applySprintEngineAutomationStopReason } from '../../utils/sprintengineSupervisorNotifications'
import { getHighlightSwatch } from '../../utils/highlight'
import { resolveWorkspaceWorktree } from '../../utils/workspaceWorktree'
import { SpecialistActionIcon, SprintEngineRoleIcon, WorkspaceTypeIcon } from '../AppIcons'
import CliIcon from '../CliIcon'
import { AgentTabIdentityPopover, type AgentTabIdentity } from './AgentTabIdentityPopover'
import { labelForCliRuntime } from './newWorkspace/cliRuntimeOptions'
import { panelTabAccentClass } from './panelTabAccent'
import { TabPromptPeek } from './TabPromptPeek'
import { GitBranchGlyph } from './WorkspaceActions'
import { ContextMenu, FOCUS_RING_CLASS, LifecycleGlyph, type LifecycleState, LoadingOverlay, MenuDivider, MenuItem, MenuSwatchRow, StatusDot, type Tone, Tooltip } from '../ui'
import AgentPanel from '../panels/AgentPanel'

interface Props {
  workspaceId: string
  onStartFuturePlan?: (source: FuturePlanWorkspaceSource) => void
  // The tab strip's "+" (MC-2147): opens the tab an agent will run in, holding
  // the launch surface until something spawns. Absent → no plus, which is how a
  // Sprint Engine workspace stays free of a hand-spawn affordance its run would
  // not know about.
  onNewAgentTab?: () => void
  // Renders the launch surface inside that tab. `tabId` is the node the spawn
  // retypes in place, so the terminal appears where the surface was.
  renderNewAgentPanel?: (tabId: string, agentName?: string) => React.ReactNode
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
const FleetPanel = React.lazy(() => import('../panels/FleetPanel'))
const FleetTerminalPanel = React.lazy(() => import('../panels/FleetTerminalPanel'))
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
// The right-docked Skills pane. Local rather than host-registered because it
// belongs to no capability module — every workspace with an agent tab can ask
// what that agent reaches — and because a module gate here would hide the pane
// its own header switch just opened.
const SkillsPanel = React.lazy(() => import('./skills/SkillsPanel'))
// Shown when a host panel can't render because its owning module is disabled or
// the layout tab is stale/unknown. An explicit, labeled unavailable state —
// never a silently blank surface — applied to every gated/stale arm below.
const DISABLED_SURFACE = (
  <div
    role="note"
    aria-label="Panel unavailable"
    className="flex h-full flex-col items-center justify-center gap-1 bg-[color:var(--bg-app)] px-6 text-center"
  >
    <p className="text-meta font-medium text-[color:var(--text-strong)]">Panel unavailable</p>
    <p className="max-w-xs text-micro leading-5 text-[color:var(--text-muted)]">
      This view isn’t available right now. Its feature may be disabled, or the tab may be out of date.
    </p>
  </div>
)
// What the tab strip's right-click menu offers, sampled when it opens.
type TabMenuState = {
  x: number
  y: number
  node: TabNode
  canHideTab: boolean
  canHideAllTabs: boolean
  canCloseOtherTabs: boolean
  isTerminal: boolean
  currentColor: HighlightColor | null
}

const AGENT_TAB_NEEDS_INPUT_CLASS = 'agent-tab-needs-input'
const loadedPanelComponents = new Set<string>()
const EMPTY_WORKSPACE_AGENTS: Workspace['agents'] = {}
const EMPTY_SPRINTENGINE_AGENTS: NonNullable<Workspace['sprintEngineState']>['sprintEngineAgents'] = {}
// Sprint agent tab role comes from the projection's worker record
// (`sprintEngineAgents[agentId].role`), never inferred from the id's string
// shape (MC-1593a). A manually-minted agent has no record until it claims a
// task, at which point the projection carries its role — the pooling model's
// "canonical on claim" contract.
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


// The kit's loading state at panel scale (spinner/component.md): the UI face,
// a sentence with a real ellipsis, and the pulsed dot. The brand mark it used
// to render was a dark-tuned hex gradient that washed out on the light themes
// (audit, suspense-loader-is-a-dark-tuned-brand-mark; ruling 6).
function PanelLoadingFallback() {
  return <LoadingOverlay label="Loading panel…" className="bg-[color:var(--bg-app)]" />
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
      className="ml-0.5 shrink-0 text-micro tabular-nums text-[color:var(--text-subtle)]"
      title={`${label} ${formatRelativeMsAgo(recency.at, now)} (${new Date(recency.at).toLocaleString()})`}
      aria-label={`${label} ${formatRelativeMsAgo(recency.at, now)}`}
    >
      {recencyText}
    </span>
  )
}

function WorkspaceLayout({ workspaceId, onStartFuturePlan, onNewAgentTab, renderNewAgentPanel }: Props) {
  const layoutModel = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.layoutModel)
  const workspaceMode = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.mode ?? 'standard')
  const openSettingsOverlay = useWorkspaceStore((s) => s.openSettingsOverlay)
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
  // workspace). The branch glyph is workspace-level on the tabs below: every
  // terminal/agent tab earns it when the workspace is worktree-backed, because
  // after the cwd-redirect slices every terminal actually runs in the worktree
  // (see the resolution in `renderTab`). Selected as primitives so the panel
  // doesn't re-render on unrelated workspace churn.
  //   - `worktreeGitRoot`: absolute git root of the workspace's worktree (null
  //      when not worktree-backed). The tab glyph condition + tooltip cwd. Covers
  //      both worktree-opened workspaces (where it equals `folderPath`) and sprint
  //      run worktrees (where it is redirected onto the run worktree).
  const worktreeGitRoot = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    return ws ? resolveWorkspaceWorktree(ws)?.gitRoot ?? null : null
  })
  const worktreeBranch = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    return ws ? resolveWorkspaceWorktree(ws)?.branch ?? null : null
  })
  // A worktree-backed workspace's worktree can be removed out from under it
  // (merge cleanup, the Worktree manager, `git worktree prune`). When it is gone,
  // the tab glyph flips to the danger token and new terminals fall back to the
  // main checkout (Slices 2-3 enforce the fallback; this is the visible signal).
  // Checked on mount, whenever the resolved worktree root changes, and on window
  // focus — no polling loop, since a worktree only vanishes via an out-of-app
  // action the user returns to the window from.
  const [worktreeMissing, setWorktreeMissing] = useState(false)
  useEffect(() => {
    if (!worktreeGitRoot) {
      setWorktreeMissing(false)
      return
    }
    let cancelled = false
    const check = (): void => {
      void window.api.pathExists(worktreeGitRoot).then((exists) => {
        if (!cancelled) setWorktreeMissing(!exists)
      })
    }
    check()
    window.addEventListener('focus', check)
    return () => {
      cancelled = true
      window.removeEventListener('focus', check)
    }
  }, [worktreeGitRoot])
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
  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null)

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
  // switchboard, memory-graph, …) are gated generically in the
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
        connectionId?: string
        machineName?: string
        remoteSessionId?: string
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
      // sprintengine, switchboard-*, memory-graph — falls
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
        // The tab the "+" opened, holding the launch surface until a spawn
        // retypes this same node into an agent tab. Nothing is created while it
        // is open, so a host that cannot spawn (no handler) renders nothing.
        case NEW_AGENT_TAB_COMPONENT:
          // The tab already wears the name its agent will take; the surface
          // hands it back on launch so the spawn adopts it.
          return renderNewAgentPanel
            ? renderNewAgentPanel(node.getId(), (config as { agentName?: string } | undefined)?.agentName)
            : null
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
        case 'skills':
          return timedPanel('SkillsPanel', <SkillsPanel workspaceId={workspaceId} />)
        // The Fleet and its terminals are core chrome, not a module: tailnet
        // remote control is a built-in opt-in feature, and a pane that vanished
        // with a module toggle would strand a person mid-session on another
        // machine.
        case 'fleet':
          return timedPanel('FleetPanel', <FleetPanel workspaceId={workspaceId} />)
        case 'fleet-terminal':
          // A stale tab whose config lost its machine is refused rather than
          // rendered as an empty terminal: there is no session to attach to, and
          // a blank xterm would look like one that simply had no output.
          return config?.connectionId && config.remoteSessionId
            ? timedPanel('FleetTerminalPanel', (
              <FleetTerminalPanel
                attachId={node.getId()}
                connectionId={config.connectionId}
                machineName={config.machineName ?? 'Remote machine'}
                sessionId={config.remoteSessionId}
              />
            ))
            : DISABLED_SURFACE
        case 'guided-brief':
          // The Design Wizard is its own module (MC-1860). Its declared
          // dependsOn ['sprint-engine'] means disabling Sprint Engine cascades
          // here too. An existing guided-brief workspace whose module is off
          // gets the labeled not-installed surface (MC-1532 pattern) rather
          // than the generic panel fallback — the workspace IS this one pane.
          return selectModuleEnabled(moduleOverrides, 'design-wizard')
            ? timedPanel(
              'GuidedBriefWorkspacePanel',
              <GuidedBriefWorkspacePanel workspaceId={workspaceId} />
            )
            : (
              <ModuleNotInstalledSurface
                label="Design Wizard"
                installed
                onOpenMarketplace={() => openSettingsOverlay({ initialTab: EXTENSIONS_BROWSE_DEEPLINK })}
              />
            )
        case 'sprintengine-run-summary':
          return sprintEngineEnabled
            ? timedPanel('SprintEngineRunSummaryPanel', (
              <SprintEngineRunSummaryPanel
                workspaceId={workspaceId}
                onClose={() => {
                  const model = modelRef.current
                  if (model) deleteTabPreservingRails(model, node.getId())
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
                  if (model) deleteTabPreservingRails(model, node.getId())
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
          if (!Panel) {
            // No registered panel: usually a stale tab, but when the component
            // id's `<moduleId>.` prefix names a known marketplace module the
            // owning module is missing, and the tab upgrades to the explicit
            // not-installed surface with the install path (MC-1532).
            return component ? (
              <MissingModulePanelSurface
                componentId={component}
                fallback={DISABLED_SURFACE}
                onOpenMarketplace={() => openSettingsOverlay({ initialTab: EXTENSIONS_BROWSE_DEEPLINK })}
              />
            ) : (
              DISABLED_SURFACE
            )
          }
          const moduleId = host.getPanelModule(component!)
          if (moduleId && !selectModuleEnabled(moduleOverrides, moduleId)) return DISABLED_SURFACE
          return timedPanel(component!, <Panel workspaceId={workspaceId} onStartFuturePlan={onStartFuturePlan} />)
        }
      }
    },
    [moduleOverrides, onStartFuturePlan, openSettingsOverlay, shouldKillTerminalOnUnmount, workspaceId]
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
      // across every remaining sibling — including the strip-less Backlog rail
      // on the left and the Skills rail on the right, either of which would
      // otherwise grow when a terminal beside it is closed. Snapshot both rails'
      // widths before the deletion applies, then re-pin them once the model has
      // settled so the freed space goes to the editor/terminal siblings instead.
      if (action.type === Actions.DELETE_TAB || action.type === Actions.DELETE_TABSET) {
        const model = modelRef.current
        const railFractions = model ? captureRailWidthFractions(model) : null
        if (railFractions != null) {
          queueMicrotask(() => {
            const current = modelRef.current
            if (current) restoreRailWidthFractions(current, railFractions)
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
    if (model) deleteTabPreservingRails(model, node.getId())
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
      deleteTabPreservingRails(model, nodeId)
    })
  }, [])

  const hideTab = useCallback((node: TabNode) => {
    if (node.getComponent() !== 'agent') return
    hideTabWithoutCleanupRef.current.add(node.getId())
    const parent = node.getParent()
    const model = modelRef.current
    if (model) deleteTabPreservingRails(model, node.getId())

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

  // The tab strip's right-click menu (MC-2104). It was a native Electron popup,
  // which meant the tab colour picker could only offer the seven highlights as
  // Title-Cased checkbox rows of their NAMES — the same choice the workspace
  // sidebar has always made as a row of swatches. Availability is sampled at
  // open time; nothing here can change while the menu is up.
  const openTabContextMenu = useCallback((event: React.MouseEvent, node: TabNode) => {
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

    const config = node.getConfig() as { highlightColor?: HighlightColor } | undefined

    setTabMenu({
      x: event.clientX,
      y: event.clientY,
      node,
      canHideTab: node.getComponent() === 'agent',
      canHideAllTabs: agentTabCount > 0,
      canCloseOtherTabs: otherClosableTabs.length > 0,
      isTerminal: node.getComponent() === 'terminal',
      currentColor: config?.highlightColor ?? null,
    })
  }, [])

  const setTabHighlightColor = useCallback((node: TabNode, nextColor: HighlightColor | undefined) => {
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
  }, [])

  const renderTab = useCallback(
    (node: TabNode, renderValues: ITabRenderValues) => {
      // Prepend a worktree branch glyph to a tab's leading slot (preserving any
      // role/specialist/highlight icon) when this tab's workspace is worktree-
      // backed. `wt` is the resolved worktree (null → no glyph); its `cwd` is
      // surfaced in the hover tooltip so the worktree's location is discoverable.
      // When `missing`, the worktree directory is gone: the glyph switches to the
      // danger token and the tooltip explains new terminals fall back to the main
      // checkout. The tooltip text carries the missing state independent of color
      // (a11y — pairs with the in-terminal fallback banner).
      const withWorktreeGlyph = (
        existing: React.ReactNode,
        wt: { cwd: string | null; branch: string | null } | null,
        missing = false,
      ): React.ReactNode => {
        if (!wt) return existing
        const heading = wt.branch ? `Worktree · ${wt.branch}` : 'Running in a git worktree'
        const title = missing
          ? `Worktree removed — ${wt.cwd ?? ''}\nNew terminals open in the main checkout.`
          : wt.cwd
            ? `${heading}\n${wt.cwd}`
            : heading
        const glyph = (
          <span
            role="img"
            className={`flex h-4 w-3.5 shrink-0 items-center justify-center ${missing ? 'text-[color:var(--tone-error)]' : 'text-[color:var(--text-muted)]'}`}
            title={title}
            aria-label={title}
          >
            <GitBranchGlyph className="icon-sm" />
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
            deleteTabPreservingRails(node.getModel(), node.getId())
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

      const tabNameSpan = (
        <span
          className={`min-w-0 truncate ${isLiveTab ? 'font-semibold' : ''}`}
          draggable={canDragOut}
          onDragStart={handleTabDragStart}
          onDragEnd={handleTabDragEnd}
          onContextMenu={(event) => openTabContextMenu(event, node)}
          onDoubleClick={canRenameTab ? (event) => startRename(event, node) : undefined}
        >
          {renderValues.content}
        </span>
      )

      // Hovering a terminal/agent tab reveals the last message sent to it — the
      // tab's own name never says what the work was. Only wrapped when there IS
      // a captured prompt: a tab with none must behave exactly as before, with
      // no empty popover and no added hover latency. Editors and panels have no
      // session, so `liveTabSession` is undefined and they fall straight through.
      const tabPrompt = liveTabSession?.lastPrompt
      const tabContent = tabPrompt ? (
        <TabPromptPeek prompt={tabPrompt} tabLabel={node.getName()}>
          {tabNameSpan}
        </TabPromptPeek>
      ) : (
        tabNameSpan
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
          // Workspace-level: every plain terminal in a worktree-backed workspace
          // runs in the worktree (the cwd-redirect slices), so all of them earn
          // the glyph — not just folder-is-a-worktree workspaces.
          renderValues.leading = withWorktreeGlyph(
            renderValues.leading,
            worktreeGitRoot ? { cwd: worktreeGitRoot, branch: worktreeBranch } : null,
            worktreeMissing,
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
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-xs ${panelTabAccentClass(isWatchtower ? 'watchtower' : 'switchboard', moduleOverrides)}`}
              title={isWatchtower ? 'Watchtower panel' : 'Switchboard panel'}
              aria-label={isWatchtower ? 'Watchtower panel' : 'Switchboard panel'}
            >
              <WorkspaceTypeIcon mode="switchboard" moduleOverrides={moduleOverrides} className="h-3.5 w-3.5" />
            </span>
          )
        } else if (componentId?.startsWith('sprintengine')) {
          renderValues.leading = (
            <span
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-xs ${panelTabAccentClass('sprintengine', moduleOverrides)}`}
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
        ? runtimeAgent?.role ?? null
        : null

      if (specialist) {
        renderValues.leading = (
          <span
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-xs text-[color:var(--text-muted)]"
            title={`${specialist.shortLabel} specialist`}
            aria-label={`${specialist.shortLabel} specialist`}
          >
            <SpecialistActionIcon icon={specialist.icon} className="h-3.5 w-3.5" />
          </span>
        )
      } else if (sprintEngineRole) {
        renderValues.leading = (
          <span
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-xs"
            title={`${sprintEngineRole} sprint agent`}
            aria-label={`${sprintEngineRole} sprint agent`}
          >
            <SprintEngineRoleIcon role={sprintEngineRole} className="h-3.5 w-3.5" />
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
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-xs text-[color:var(--text-muted)]"
            title={runtimeLabel}
            aria-label={runtimeLabel}
          >
            <CliIcon cli={agent.cli} className="h-3.5 w-3.5" />
          </span>
        )
      } else {
        renderValues.leading = null
      }
      // Worktree glyph. Workspace-level: any agent in a worktree-backed workspace
      // earns it, because the cwd-redirect slices run every terminal in the
      // worktree. Plus the standalone per-agent persisted case: an agent whose
      // `execution.mode === 'worktree'` earns it even in a workspace that is not
      // itself worktree-backed (a persisted worktree agent), reading its own cwd.
      const agentWorktree: { cwd: string | null; branch: string | null } | null =
        worktreeGitRoot
          ? { cwd: worktreeGitRoot, branch: worktreeBranch }
          : agent?.execution.mode === 'worktree'
            ? { cwd: agent.execution.cwd ?? null, branch: worktreeBranch }
            : null
      renderValues.leading = withWorktreeGlyph(renderValues.leading, agentWorktree, worktreeMissing)

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
              className="ml-0.5 shrink-0 text-micro tabular-nums text-[color:var(--text-subtle)]"
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
      // An agent with neither a specialist nor a sprint role has no role at all,
      // and the card's own Model and Runtime rows already name what it runs.
      const roleLabel = specialist
        ? `${specialist.shortLabel} specialist`
        : sprintEngineRole
          ? `${prettyRole(sprintEngineRole)} · sprint`
          : 'No role'
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
        lastMessage: tabPrompt ?? null,
      }

      // The identity card carries the last message itself, so the agent tab
      // takes the bare name — wrapping `tabContent` here would open the peek
      // popover UNDER this card and leave two hover surfaces fighting over the
      // same pointer. Plain terminal tabs, which have no identity card, keep
      // the peek as their only reveal.
      renderValues.content = (
        <AgentTabIdentityPopover identity={agentIdentity}>
          {tabNameSpan}
          {trailing}
        </AgentTabIdentityPopover>
      )
    },
    [commitRename, editorOpenFiles, hideTab, lastTerminalActivityAt, moduleOverrides, now, renameValue, renamingTabId, openTabContextMenu, sprintEngineAgents, startRename, terminalSessions, workspaceAgents, worktreeBranch, worktreeGitRoot, worktreeMissing, workspaceId]
  )

  const handleContextMenu = useCallback<NodeMouseEvent>((node, event) => {
    if (!(node instanceof TabNode)) return
    event.preventDefault()
    event.stopPropagation()
    openTabContextMenu(event, node)
  }, [openTabContextMenu])

  // The tab strip's "+" (MC-2147). It rides the tabsets that host agents and
  // terminals — never a rail pane, whose strip is chrome for a panel, and never
  // an editor-only column, where a new agent has nothing to do with the files
  // beside it. Sticky, so it stays put when the tabs overflow and scroll.
  const renderTabSet = useCallback<(tabSetNode: TabSetNode | BorderNode, values: ITabSetRenderValues) => void>(
    (tabSetNode, values) => {
      if (!onNewAgentTab) return
      if (!(tabSetNode instanceof TabSetNode)) return
      if (tabSetNode.getChildren().length === 0) return
      const hostsAgents = tabSetNode.getChildren().some((child) => {
        if (!(child instanceof TabNode)) return false
        const component = child.getComponent()
        return component === 'agent' || component === 'terminal' || component === NEW_AGENT_TAB_COMPONENT
      })
      if (!hostsAgents) return
      values.stickyButtons.push(
        <Tooltip key="new-agent" content="New agent" placement="bottom">
          <button
            type="button"
            aria-label="New agent"
            onClick={(event) => {
              // The strip's own click handler would select whatever tab sits
              // under the button; this is a control, not a tab.
              event.stopPropagation()
              onNewAgentTab()
            }}
            className={`interactive grid h-7 w-[26px] place-items-center rounded text-[color:var(--text-disabled)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="icon-xs">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
            </svg>
          </button>
        </Tooltip>,
      )
    },
    [onNewAgentTab],
  )

  const isEmpty = countOpenTabs(modelRef.current) === 0

  // An empty workspace lands on the New chat surface, not on a launcher page of
  // its own (2026-09-03). The tab the "+" opens IS that surface — same composer,
  // same prompt box, same permission and connector controls — so a workspace
  // with nothing in it opens one instead of standing in front of a second,
  // older chooser that offered a subset of the same choices. That is also what
  // makes a spawn from here work at all: every spawn path bails without a
  // tabset, and an empty FlexLayout model often has none, so the tab both shows
  // the surface and creates the tabset its terminal will dock into.
  //
  // The floor, not a one-shot: close the last tab and another opens, because a
  // workspace with no tabs has nothing to show and no way to start. The handler
  // is absent on background layers and outside standard workspaces, so neither
  // gets a tab it never asked for.
  const openNewAgentTabRef = useRef(onNewAgentTab)
  openNewAgentTabRef.current = onNewAgentTab
  // The handler's identity changes every render, so the effect watches whether
  // there is one rather than which one, and calls through the ref.
  const canOpenNewAgentTab = Boolean(onNewAgentTab)
  useEffect(() => {
    if (!isEmpty || !canOpenNewAgentTab) return
    openNewAgentTabRef.current?.()
  }, [isEmpty, canOpenNewAgentTab])

  // A workspace whose mode has no registered type: the owning module is not
  // installed (fresh machine, uninstalled, or a marketplace module pending
  // install). An explicit, labeled state with an install path — never a grid
  // of blank "Panel unavailable" tabs. Data stays on disk; installing the
  // module and relaunching renders the workspace again. (A DISABLED bundled
  // module still has a registered type and keeps the existing per-tab gating;
  // shell-owned hidden host modes — sprintengine, automations-host,
  // reviews-host — are not module-owned surfaces and keep their layouts.)
  if (
    workspaceMode !== 'standard'
    && !isModeHiddenFromRail(workspaceMode)
    && !getRendererHost().getWorkspaceType(workspaceMode)
  ) {
    return (
      <ModuleNotInstalledSurface
        label={moduleLabelForMode(workspaceMode)}
        onOpenMarketplace={() => openSettingsOverlay({ initialTab: EXTENSIONS_BROWSE_DEEPLINK })}
      />
    )
  }

  return (
    <div className="relative h-full" onMouseDownCapture={handleMouseDownCapture}>
      <Layout
        model={modelRef.current}
        factory={factory}
        icons={FLEX_LAYOUT_ICONS}
        onAction={handleAction}
        onAuxMouseClick={handleAuxMouseClick}
        onContextMenu={handleContextMenu}
        onRenderTab={renderTab}
        onRenderTabSet={renderTabSet}
        onModelChange={(model) => {
          updateLayout(workspaceId, model.toJson())
        }}
      />
      {tabMenu ? (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          ariaLabel={`Tab actions: ${tabMenu.node.getName()}`}
          onClose={() => setTabMenu(null)}
          surfaceClassName="min-w-[196px]"
        >
          <MenuItem
            disabled={!tabMenu.canHideTab}
            onClick={() => {
              const { node } = tabMenu
              setTabMenu(null)
              hideTab(node)
            }}
          >
            Hide tab
          </MenuItem>
          <MenuItem
            disabled={!tabMenu.canHideAllTabs}
            onClick={() => {
              setTabMenu(null)
              hideAllAgentTabs()
            }}
          >
            Hide all
          </MenuItem>
          <MenuItem
            disabled={!tabMenu.canCloseOtherTabs}
            onClick={() => {
              const { node } = tabMenu
              setTabMenu(null)
              closeOtherTabsInSet(node)
            }}
          >
            Close other tabs
          </MenuItem>
          {tabMenu.isTerminal ? (
            <>
              <MenuDivider />
              <MenuSwatchRow
                label="Color"
                value={tabMenu.currentColor}
                onPick={(color) => {
                  const { node } = tabMenu
                  setTabMenu(null)
                  setTabHighlightColor(node, color)
                }}
                onClear={() => {
                  const { node } = tabMenu
                  setTabMenu(null)
                  setTabHighlightColor(node, undefined)
                }}
              />
            </>
          ) : null}
        </ContextMenu>
      ) : null}
    </div>
  )
}

export default React.memo(WorkspaceLayout)
