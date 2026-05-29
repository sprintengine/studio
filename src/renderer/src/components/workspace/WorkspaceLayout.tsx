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
import type { FuturePlanWorkspaceSource, HighlightColor, SprintEngineRole, SprintEngineRuntimeAgentStatus } from '../../types/workspace'
import { registerModel, unregisterModel } from '../../utils/modelRegistry'
import { TAB_DRAG_MIME, serializeTabDragPayload } from '../../utils/tabDragPayload'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { disableSprintEngineAutoRun } from '../../utils/sprintengineSupervisorNotifications'
import { HIGHLIGHT_COLORS, getHighlightSwatch } from '../../utils/highlight'
import { SpecialistActionIcon, SprintEngineRoleIcon, WorkspaceTypeIcon } from '../AppIcons'
import { StatusDot, type Tone } from '../ui'
import MulticodeSpinner from '../brand/MulticodeSpinner'
import AgentPanel from '../panels/AgentPanel'

interface Props {
  workspaceId: string
  onStartFuturePlan?: (source: FuturePlanWorkspaceSource) => void
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
// Shown for a disabled module's panel or an unknown/stale layout component.
const EMPTY_SURFACE = <div className="h-full bg-[color:var(--bg-app)]" />
const AGENT_TAB_NEEDS_INPUT_CLASS = 'agent-tab-needs-input'
const loadedPanelComponents = new Set<string>()
type AgentTabActivity = 'needs-input' | 'working' | 'failed' | 'idle'
const SPRINTENGINE_ROLES: SprintEngineRole[] = [
  'architect',
  'product',
  'developer',
  'frontend',
  'tester',
  'security',
  'code_reviewer',
  'spec_reviewer',
  'performance',
]

type AgentTabActivityDot = {
  tone: Tone
  pulse: boolean
  label: string
}

function agentTabActivity(
  session: TerminalSessionSnapshot | undefined,
  runtimeStatus: SprintEngineRuntimeAgentStatus | undefined
): AgentTabActivity {
  if (runtimeStatus === 'needs_input') return 'needs-input'
  if (isSessionWorking(session)) return 'working'
  if (isSessionFailed(session)) return 'failed'
  return 'idle'
}

function agentTabActivityDot(
  activity: AgentTabActivity,
  currentTaskId: string | null | undefined
): AgentTabActivityDot | null {
  switch (activity) {
    case 'needs-input':
      return {
        tone: 'warn',
        pulse: true,
        label: currentTaskId ? `Needs input on ${currentTaskId}` : 'Needs input',
      }
    case 'working':
      return {
        tone: 'good',
        pulse: true,
        label: 'Working',
      }
    case 'failed':
      return {
        tone: 'error',
        pulse: false,
        label: 'Failed',
      }
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
  if (isSessionWorking(session)) {
    return <StatusDot tone="good" pulse label="Working" className="ml-0.5" />
  }
  if (isSessionFailed(session)) {
    return <StatusDot tone="error" label="Failed" className="ml-0.5" />
  }
  const recency = pickTerminalTabRecency(session)
  if (!recency) return null
  const label = tabRecencyLabel(recency.source)
  return (
    <span
      className="ml-0.5 shrink-0 text-[10px] tabular-nums text-[color:var(--text-subtle)]"
      title={`${label} ${formatRelativeMsAgo(recency.at, now)} (${new Date(recency.at).toLocaleString()})`}
      aria-label={`${label} ${formatRelativeMsAgo(recency.at, now)}`}
    >
      {formatRelativeMs(recency.at, now)}
    </span>
  )
}

function WorkspaceLayout({ workspaceId, onStartFuturePlan }: Props) {
  const workspace    = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId))
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

  if (!workspace) return null
  if (!modelRef.current) {
    modelRef.current = Model.fromJson(workspace.layoutModel)
    modelRef.current.doAction(Actions.updateModelAttributes({ tabEnableRename: false }))
  }

  useEffect(() => {
    if (modelRef.current) registerModel(workspaceId, modelRef.current)
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
      const agent = workspace.agents[agentId]
      const currentClassName = node.getClassName() ?? ''
      const classNames = currentClassName.split(/\s+/).filter(Boolean)
      const needsInput = workspace.sprintEngineState?.sprintEngineAgents[agentId]?.status === 'needs_input'
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
  }, [workspace.agents, workspace.mode, workspace.sprintEngineState?.sprintEngineAgents])

  // Capability-module gate. Host-registered panels (editor, git, sprintengine,
  // switchboard, multiloop, memory-graph, …) are gated generically in the
  // factory's default case by their owning module's enablement, so a disabled
  // module's panel falls back to an empty surface and PanelRail hides its
  // button. Only the panels with bespoke props (file-editor, explorer, the
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
            : EMPTY_SURFACE
        case 'explorer':
          return devToolsEnabled
            ? timedPanel('FileExplorer', <FileExplorer workspaceId={workspaceId} onStartFuturePlan={onStartFuturePlan} />)
            : EMPTY_SURFACE
        case 'git-conflict':
          return gitEnabled && config?.repoRoot && config.filePath
            ? timedPanel('GitConflictResolverPanel', (
              <GitConflictResolverPanel
                workspaceId={workspaceId}
                repoRoot={config.repoRoot}
                filePath={config.filePath}
              />
            ))
            : EMPTY_SURFACE
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
            : EMPTY_SURFACE
        case 'sprintengine-roster':
          return sprintEngineEnabled
            ? timedPanel('SprintEngineBoardPanel', <SprintEngineBoardPanel workspaceId={workspaceId} fixedView="roster" />)
            : EMPTY_SURFACE
        case 'sprintengine-tasks':
          return sprintEngineEnabled
            ? timedPanel('SprintEngineBoardPanel', <SprintEngineBoardPanel workspaceId={workspaceId} fixedView="tasks" />)
            : EMPTY_SURFACE
        case 'guided-brief':
          // Guided Brief hands its build off to a Sprint Engine run, so it
          // follows sprint-engine enablement: a stale guided-brief workspace
          // blanks when Sprint Engine is disabled, matching the other modes.
          return sprintEngineEnabled
            ? timedPanel(
              'GuidedBriefWorkspacePanel',
              <GuidedBriefWorkspacePanel workspaceId={workspaceId} />
            )
            : EMPTY_SURFACE
        case 'sprintengine-run-summary':
          return sprintEngineEnabled
            ? timedPanel('SprintEngineRunSummaryPanel', (
              <SprintEngineRunSummaryPanel
                workspaceId={workspaceId}
                onClose={() => {
                  modelRef.current?.doAction(Actions.deleteTab(node.getId()))
                }}
              />
            ))
            : EMPTY_SURFACE
        case 'sprintengine-plan-reader':
          return sprintEngineEnabled
            ? timedPanel('SprintEnginePlanReaderPanel', (
              <SprintEnginePlanReaderPanel
                workspaceId={workspaceId}
                onClose={() => {
                  modelRef.current?.doAction(Actions.deleteTab(node.getId()))
                }}
              />
            ))
            : EMPTY_SURFACE
        default: {
          // Host-registered panels: render the registered component gated by its
          // owning module's enablement. A disabled module (or an unknown/stale
          // component) falls back to an empty surface.
          const host = getRendererHost()
          const Panel = component ? host.getPanel(component) : undefined
          if (!Panel) return EMPTY_SURFACE
          const moduleId = host.getPanelModule(component!)
          if (moduleId && !selectModuleEnabled(moduleOverrides, moduleId)) return EMPTY_SURFACE
          return timedPanel(component!, <Panel workspaceId={workspaceId} />)
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
        const agent = workspace.agents[agentId]
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
            disableSprintEngineAutoRun(workspaceId, 'agent_terminal_closed', { agentId })
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
    [closeFile, terminalSessions, updateAgent, workspace.agents, workspaceId]
  )

  const handleAction = useCallback(
    (action: Action) => {
      if (action.type === Actions.DELETE_TAB) {
        const node = modelRef.current?.getNodeById(action.data.node)
        const nodeId = node?.getId() ?? String(action.data.node ?? '')
        if (hideTabWithoutCleanupRef.current.has(nodeId)) {
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
    modelRef.current?.doAction(Actions.deleteTab(node.getId()))
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
      model.doAction(Actions.deleteTab(nodeId))
    })
  }, [])

  const hideTab = useCallback((node: TabNode) => {
    if (node.getComponent() !== 'agent') return
    hideTabWithoutCleanupRef.current.add(node.getId())
    const parent = node.getParent()
    modelRef.current?.doAction(Actions.deleteTab(node.getId()))

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
      const tabContent = (
        <span
          className="min-w-0 truncate"
          draggable={canDragOut}
          onDragStart={handleTabDragStart}
          onContextMenu={(event) => void showTabContextMenu(event, node)}
          onDoubleClick={canRenameTab ? (event) => startRename(event, node) : undefined}
        >
          {renderValues.content}
        </span>
      )

      if (node.getComponent() === 'file-editor') {
        const config = node.getConfig() as { filePath?: string } | undefined
        const file = workspace.editorState?.openFiles.find((openFile) => openFile.path === config?.filePath)
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
          renderValues.leading = (
            <span
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] ${
                isWatchtower ? 'text-[color:var(--tool-watchtower)]' : 'text-[color:var(--tool-switchboard)]'
              }`}
              title={isWatchtower ? 'Watchtower panel' : 'Switchboard panel'}
              aria-label={isWatchtower ? 'Watchtower panel' : 'Switchboard panel'}
            >
              <WorkspaceTypeIcon mode={isWatchtower ? 'switchboard' : 'switchboard'} className="h-3.5 w-3.5" />
            </span>
          )
        } else if (componentId?.startsWith('sprintengine')) {
          const iconMode = 'sprintengine'
          renderValues.leading = (
            <span
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] ${
                'text-[color:var(--tool-sprintengine)]'
              }`}
              title='Sprint Engine panel'
              aria-label='Sprint Engine panel'
            >
              <WorkspaceTypeIcon mode={iconMode} className="h-3.5 w-3.5" />
            </span>
          )
        }
        renderValues.content = tabContent
        return
      }

      const config = node.getConfig() as { agentId?: string; sessionId?: string } | undefined
      const agentId = config?.agentId ?? node.getId()
      const agent = workspace.agents[agentId]
      const agentSessionId = config?.sessionId ?? agent?.cliSessionId
      const runtimeAgent = workspace.sprintEngineState?.sprintEngineAgents[agentId]
      const agentSession = agentSessionId
        ? terminalSessions.find((s) => s.sessionId === agentSessionId)
        : undefined
      const activity = agentTabActivity(agentSession, runtimeAgent?.status)
      const currentTaskId = runtimeAgent?.currentTaskId
      const activityDot = agentTabActivityDot(activity, currentTaskId)
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
            title={`${sprintEngineRole} Sprint Engine agent`}
            aria-label={`${sprintEngineRole} Sprint Engine agent`}
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
            <WorkspaceTypeIcon mode="multiloop" className="h-3.5 w-3.5" />
          </span>
        )
      } else {
        renderValues.leading = null
      }

      const agentRecency = activity === 'working'
        ? null
        : pickAgentTabRecency(
            agentSession,
            workspace.lastTerminalActivityAt,
            agent?.cliLastExitedAt
          )
      const recencyIndicator = agentRecency !== null
        ? (
            <span
              className="ml-0.5 shrink-0 text-[10px] tabular-nums text-[color:var(--text-subtle)]"
              title={`${tabRecencyLabel(agentRecency.source)} ${formatRelativeMsAgo(agentRecency.at, now)} (${new Date(agentRecency.at).toLocaleString()})`}
              aria-label={`${tabRecencyLabel(agentRecency.source)} ${formatRelativeMsAgo(agentRecency.at, now)}`}
            >
              {formatRelativeMs(agentRecency.at, now)}
            </span>
          )
        : null

      if (activityDot) {
        renderValues.content = (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            {tabContent}
            <StatusDot tone={activityDot.tone} pulse={activityDot.pulse} label={activityDot.label} />
            {recencyIndicator}
          </span>
        )
      } else {
        renderValues.content = (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            {tabContent}
            {recencyIndicator}
          </span>
        )
      }
    },
    [commitRename, hideTab, renameValue, renamingTabId, showTabContextMenu, startRename, terminalSessions, now, workspace.agents, workspace.editorState?.openFiles, workspace.lastTerminalActivityAt, workspace.sprintEngineState, workspaceId]
  )

  const handleContextMenu = useCallback<NodeMouseEvent>((node, event) => {
    if (!(node instanceof TabNode)) return
    event.preventDefault()
    event.stopPropagation()
    void showTabContextMenu(event, node)
  }, [showTabContextMenu])

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
    </div>
  )
}

export default React.memo(WorkspaceLayout)
