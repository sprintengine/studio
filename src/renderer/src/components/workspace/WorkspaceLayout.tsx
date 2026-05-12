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
import 'flexlayout-react/style/dark.css'
import { getSpecialistAction } from '../../specialists/specialistActions'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useTerminalSessions } from '../../hooks/useTerminalSessions'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import { formatRelativeMs, formatRelativeMsAgo } from '../../utils/relativeTime'
import type { AgentState, FuturePlanWorkspaceSource, HighlightColor, SprintEngineRole, SprintEngineRuntimeAgentStatus } from '../../types/workspace'
import { registerModel, unregisterModel } from '../../utils/modelRegistry'
import { TAB_DRAG_MIME, serializeTabDragPayload } from '../../utils/tabDragPayload'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { sprintEngineRoleAccent } from '../../utils/sprintengine'
import { HIGHLIGHT_COLORS, getHighlightSwatch } from '../../utils/highlight'
import { SpecialistActionIcon, StatusDot, SprintEngineRoleIcon, WorkspaceTypeIcon } from '../AppIcons'
import MulticodeSpinner from '../brand/MulticodeSpinner'
import AgentPanel from '../panels/AgentPanel'
import FileExplorer from '../panels/FileExplorer'
import SettingsPanel from '../settings/SettingsPanel'
import SprintEngineRunSummaryPanel from '../panels/SprintEngineRunSummaryPanel'
import SprintEnginePlanReaderPanel from '../panels/SprintEnginePlanReaderPanel'

interface Props {
  workspaceId: string
  onStartFuturePlan?: (source: FuturePlanWorkspaceSource) => void
}

const EditorPanel = React.lazy(() => import('../panels/EditorPanel'))
const ContentSearchPanel = React.lazy(() => import('../panels/ContentSearchPanel'))
const GitPanel = React.lazy(() => import('../panels/GitPanel'))
const GitConflictResolverPanel = React.lazy(() => import('../panels/GitConflictResolverPanel'))
const PlainTerminalPanel = React.lazy(() => import('../panels/PlainTerminalPanel'))
const SprintEngineBoardPanel = React.lazy(() => import('../panels/SprintEngineBoardPanel'))
const MultiloopBoardPanel = React.lazy(() => import('../panels/MultiloopBoardPanel'))
const WatchtowerPanel = React.lazy(() => import('../panels/WatchtowerPanel'))
const SwitchboardBoardPanel = React.lazy(() => import('../panels/SwitchboardBoardPanel'))
const MemoryGraphPanel = React.lazy(() => import('../panels/MemoryGraphPanel'))
const AGENT_TAB_NEEDS_INPUT_CLASS = 'agent-tab-needs-input'
const AGENT_TAB_ROLE_CLASS_PREFIX = 'agent-tab-role-'
const loadedPanelComponents = new Set<string>()
type AgentTabActivity = 'needs-input' | 'running' | 'idle'
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
  tone: 'running' | 'needs-input'
  label: string
}

function agentTabActivity(
  agent: AgentState | undefined,
  runtimeStatus: SprintEngineRuntimeAgentStatus | undefined
): AgentTabActivity {
  if (runtimeStatus === 'needs_input') return 'needs-input'
  if (agent?.cliStartRequested || agent?.cliHasLaunched || agent?.cliSessionId) return 'running'
  return 'idle'
}

function agentTabActivityDot(
  activity: AgentTabActivity,
  currentTaskId: string | null | undefined
): AgentTabActivityDot | null {
  switch (activity) {
    case 'needs-input':
      return {
        tone: 'needs-input',
        label: currentTaskId ? `Needs input on ${currentTaskId}` : 'Needs input',
      }
    case 'running':
      return {
        tone: 'running',
        label: 'CLI running',
      }
    default:
      return null
  }
}

function inferSprintEngineRoleFromAgentId(agentId: string): SprintEngineRole | null {
  return SPRINTENGINE_ROLES.find((role) => agentId === role || agentId.startsWith(`${role}-`)) ?? null
}

function sprintEngineRoleTabClass(role: SprintEngineRole): string {
  return `${AGENT_TAB_ROLE_CLASS_PREFIX}${role.replace(/_/g, '-')}`
}

function PanelLoadingFallback() {
  return (
    <div className="flex h-full items-center justify-center bg-[#08090b] text-[12px] font-mono text-[#6f7078]">
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
  if (session.running) {
    return (
      <span
        className="ml-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#30d158]"
        title="Running"
        aria-label="Running"
      />
    )
  }
  if (typeof session.exitedAt !== 'number') return null
  return (
    <span
      className="ml-0.5 shrink-0 text-[10px] tabular-nums text-[#6f7078]"
      title={`Exited ${formatRelativeMsAgo(session.exitedAt, now)} (${new Date(session.exitedAt).toLocaleString()})`}
      aria-label={`Exited ${formatRelativeMsAgo(session.exitedAt, now)}`}
    >
      {formatRelativeMs(session.exitedAt, now)}
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
  const setSprintEngineAutoEnabled = useWorkspaceStore((s) => s.setSprintEngineAutoEnabled)
  // Keep a stable Model instance per workspace — re-creating it destroys drag/resize state
  const modelRef = useRef<Model | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const skipNextRenameCommitRef = useRef(false)
  const hideTabWithoutCleanupRef = useRef(new Set<string>())
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
      const role = agent?.kind === 'sprintengine'
        ? workspace.sprintEngineState?.sprintEngineAgents[agentId]?.role ?? inferSprintEngineRoleFromAgentId(agentId)
        : null
      const currentClassName = node.getClassName() ?? ''
      const classNames = currentClassName.split(/\s+/).filter(Boolean)
      const needsInput = workspace.sprintEngineState?.sprintEngineAgents[agentId]?.status === 'needs_input'
      const roleClassNames = new Set(SPRINTENGINE_ROLES.map(sprintEngineRoleTabClass))
      const nextClassNames = classNames.filter((className) => !roleClassNames.has(className))
      if (agent?.name && node.getName() !== agent.name) {
        model.doAction(Actions.renameTab(node.getId(), agent.name))
      }

      if (needsInput) {
        nextClassNames.push(AGENT_TAB_NEEDS_INPUT_CLASS)
      }

      if (role) {
        nextClassNames.push(sprintEngineRoleTabClass(role))
      }

      const nextClassName = Array.from(new Set(nextClassNames)).join(' ')
      if (nextClassName !== currentClassName) {
        model.doAction(Actions.updateNodeAttributes(node.getId(), {
          className: nextClassName,
        }))
      }
    })
  }, [workspace.agents, workspace.mode, workspace.sprintEngineState?.sprintEngineAgents])

  const factory = useCallback(
    (node: TabNode) => {
      const component = node.getComponent()
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
            style={{
              boxShadow: `inset 0 0 0 2px ${swatch.hex}, inset 0 0 24px -8px ${swatch.ringRgba(0.55)}`,
            }}
          >
            {children}
          </div>
        )
      }

      switch (component) {
        case 'agent':
          return (
            <AgentPanel
              workspaceId={workspaceId}
              agentId={config?.agentId ?? node.getId()}
              sessionId={config?.sessionId}
            />
          )
        case 'editor':
          return timedPanel('EditorPanel', <EditorPanel workspaceId={workspaceId} />)
        case 'file-editor':
          return config?.filePath
            ? timedPanel('EditorPanel', <EditorPanel workspaceId={workspaceId} filePath={config.filePath} />)
            : <div className="h-full bg-[#08090b]" />
        case 'explorer':
          return <FileExplorer workspaceId={workspaceId} onStartFuturePlan={onStartFuturePlan} />
        case 'content-search':
          return timedPanel('ContentSearchPanel', <ContentSearchPanel workspaceId={workspaceId} />)
        case 'git':
          return timedPanel('GitPanel', <GitPanel workspaceId={workspaceId} />)
        case 'git-conflict':
          return config?.repoRoot && config.filePath
            ? timedPanel('GitConflictResolverPanel', (
              <GitConflictResolverPanel
                workspaceId={workspaceId}
                repoRoot={config.repoRoot}
                filePath={config.filePath}
              />
            ))
            : <div className="h-full bg-[#08090b]" />
        case 'terminal':
          return wrapWithHighlight(timedPanel('PlainTerminalPanel', (
            <PlainTerminalPanel
              workspaceId={workspaceId}
              terminalId={config?.terminalId ?? node.getId()}
            />
          )))
        case 'sprintengine':
          return timedPanel('SprintEngineBoardPanel', <SprintEngineBoardPanel workspaceId={workspaceId} />)
        case 'sprintengine-project':
        case 'sprintengine-map':
          return timedPanel('SprintEngineBoardPanel', <SprintEngineBoardPanel workspaceId={workspaceId} fixedView="project" />)
        case 'sprintengine-task-graph':
          return timedPanel('SprintEngineBoardPanel', <SprintEngineBoardPanel workspaceId={workspaceId} fixedView="task-graph" />)
        case 'sprintengine-kanban':
          return timedPanel('SprintEngineBoardPanel', <SprintEngineBoardPanel workspaceId={workspaceId} fixedView="kanban" />)
        case 'multiloop-board':
          return timedPanel(
            'MultiloopBoardPanel',
            <MultiloopBoardPanel workspaceId={workspaceId} />
          )
        case 'watchtower-panel':
          return timedPanel('WatchtowerPanel', <WatchtowerPanel workspaceId={workspaceId} />)
        case 'switchboard-board':
          return timedPanel('SwitchboardBoardPanel', <SwitchboardBoardPanel workspaceId={workspaceId} />)
        case 'memory-graph':
          return timedPanel('MemoryGraphPanel', <MemoryGraphPanel workspaceId={workspaceId} />)
        case 'settings':
          return (
            <SettingsPanel
              checkForUpdatesRequestId={config?.checkForUpdatesRequestId}
              initialTab={config?.initialTab ?? null}
              onOpenSettingsTab={(tabId) => {
                modelRef.current?.doAction(
                  Actions.updateNodeAttributes(node.getId(), { config: { initialTab: tabId } })
                )
              }}
              onClose={() => {
                modelRef.current?.doAction(Actions.deleteTab(node.getId()))
              }}
            />
          )
        case 'sprintengine-run-summary':
          return (
            <SprintEngineRunSummaryPanel
              workspaceId={workspaceId}
              onClose={() => {
                modelRef.current?.doAction(Actions.deleteTab(node.getId()))
              }}
            />
          )
        case 'sprintengine-plan-reader':
          return (
            <SprintEnginePlanReaderPanel
              workspaceId={workspaceId}
              onClose={() => {
                modelRef.current?.doAction(Actions.deleteTab(node.getId()))
              }}
            />
          )
        default:
          return <div className="h-full bg-[#08090b]" />
      }
    },
    [onStartFuturePlan, workspaceId]
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
        const sessionId = config?.sessionId ?? agent?.cliSessionId
        if (sessionId) void window.api.terminalKill(sessionId).catch(() => {})
        if (agent) {
          if (agent.kind === 'sprintengine') setSprintEngineAutoEnabled(workspaceId, false)
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
        void window.api.terminalKill(`terminal-${terminalId}`).catch(() => {})
      }
    },
    [closeFile, setSprintEngineAutoEnabled, updateAgent, workspace.agents, workspaceId]
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

  const handleAuxMouseClick = useCallback<NodeMouseEvent>((node, event) => {
    if (event.button !== 1 || !(node instanceof TabNode) || !node.isEnableClose()) return

    event.preventDefault()
    event.stopPropagation()
    modelRef.current?.doAction(Actions.deleteTab(node.getId()))
  }, [])

  const handleMouseDownCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 1) return
    if (event.target instanceof Element && event.target.closest('.flexlayout__tab_button')) {
      event.preventDefault()
    }
  }, [])

  const closeOtherTabsInSet = useCallback((node: TabNode) => {
    const parent = node.getParent()
    if (!(parent instanceof TabSetNode)) return

    parent.getChildren().forEach((child) => {
      if (!(child instanceof TabNode) || child.getId() === node.getId() || !child.isEnableClose()) return
      modelRef.current?.doAction(Actions.deleteTab(child.getId()))
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
      // `agent-tab-role-*` and `agent-tab-needs-input`.
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
  }, [closeOtherTabsInSet, hideTab])

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
              <span className="shrink-0 text-[#f2c45f]" aria-label="Unsaved changes" title="Unsaved changes">
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
                style={{
                  backgroundColor: swatch.hex,
                  boxShadow: `0 0 6px ${swatch.ringRgba(0.65)}`,
                }}
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
                isWatchtower ? 'text-[#d97757]' : 'text-[#a78bfa]'
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
                'text-[#ffbf2f]'
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
      const activity = agentTabActivity(agent, runtimeAgent?.status)
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
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] text-[#9a9aa2]"
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
            style={{ color: sprintEngineRoleAccent[sprintEngineRole] }}
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

      const agentSession = agentSessionId
        ? terminalSessions.find((s) => s.sessionId === agentSessionId)
        : undefined
      const agentExitedAt =
        agentSession && !agentSession.running && typeof agentSession.exitedAt === 'number'
          ? agentSession.exitedAt
          : typeof agent?.cliLastExitedAt === 'number' && (!agentSession || !agentSession.running)
            ? agent.cliLastExitedAt
            : null
      const exitIndicator = agentExitedAt !== null
        ? (
            <span
              className="ml-0.5 shrink-0 text-[10px] tabular-nums text-[#6f7078]"
              title={`Exited ${formatRelativeMsAgo(agentExitedAt, now)} (${new Date(agentExitedAt).toLocaleString()})`}
              aria-label={`Exited ${formatRelativeMsAgo(agentExitedAt, now)}`}
            >
              {formatRelativeMs(agentExitedAt, now)}
            </span>
          )
        : null

      if (activityDot) {
        renderValues.content = (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            {tabContent}
            <StatusDot tone={activityDot.tone} label={activityDot.label} />
            {exitIndicator}
          </span>
        )
      } else {
        renderValues.content = (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            {tabContent}
            {exitIndicator}
          </span>
        )
      }
    },
    [commitRename, hideTab, renameValue, renamingTabId, showTabContextMenu, startRename, terminalSessions, now, workspace.agents, workspace.editorState?.openFiles, workspace.sprintEngineState, workspaceId]
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
