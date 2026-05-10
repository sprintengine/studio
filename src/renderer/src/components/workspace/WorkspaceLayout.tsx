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
import type { AgentState, FuturePlanWorkspaceSource, SprintEngineRole, SprintEngineRuntimeAgentStatus } from '../../types/workspace'
import { registerModel, unregisterModel } from '../../utils/modelRegistry'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { SpecialistActionIcon, StatusDot, SprintEngineRoleIcon, WorkspaceTypeIcon } from '../AppIcons'
import MulticodeBlackHoleSpinner from '../brand/MulticodeBlackHoleSpinner'
import AgentPanel from '../panels/AgentPanel'
import FileExplorer from '../panels/FileExplorer'

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
const MobileCompanionPanel = React.lazy(() => import('../panels/MobileCompanionPanel'))
const AGENT_TAB_NEEDS_INPUT_CLASS = 'agent-tab-needs-input'
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

function PanelLoadingFallback() {
  return (
    <div className="flex h-full items-center justify-center bg-[#08090b] text-[12px] font-mono text-[#6f7078]">
      <span className="flex items-center gap-3">
        <MulticodeBlackHoleSpinner className="h-8 w-8" />
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

function WorkspaceLayout({ workspaceId, onStartFuturePlan }: Props) {
  const workspace    = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId))
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
      const currentClassName = node.getClassName() ?? ''
      const classNames = currentClassName.split(/\s+/).filter(Boolean)
      const hasClass = classNames.includes(AGENT_TAB_NEEDS_INPUT_CLASS)
      const needsInput = workspace.sprintEngineState?.sprintEngineAgents[agentId]?.status === 'needs_input'
      if (agent?.name && node.getName() !== agent.name) {
        model.doAction(Actions.renameTab(node.getId(), agent.name))
      }

      if (needsInput && !hasClass) {
        model.doAction(Actions.updateNodeAttributes(node.getId(), {
          className: [...classNames, AGENT_TAB_NEEDS_INPUT_CLASS].join(' '),
        }))
      }

      if (!needsInput && hasClass) {
        model.doAction(Actions.updateNodeAttributes(node.getId(), {
          className: classNames
            .filter((className) => className !== AGENT_TAB_NEEDS_INPUT_CLASS)
            .join(' '),
        }))
      }
    })
  }, [workspace.agents, workspace.mode, workspace.sprintEngineState?.sprintEngineAgents])

  const factory = useCallback(
    (node: TabNode) => {
      const component = node.getComponent()
      const config = node.getConfig() as { agentId?: string; terminalId?: string; filePath?: string; repoRoot?: string } | undefined

      switch (component) {
        case 'agent':
          return (
            <AgentPanel
              workspaceId={workspaceId}
              agentId={config?.agentId ?? node.getId()}
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
          return timedPanel('PlainTerminalPanel', (
            <PlainTerminalPanel
              workspaceId={workspaceId}
              terminalId={config?.terminalId ?? node.getId()}
            />
          ))
        case 'sprintengine':
          return timedPanel('SprintEngineBoardPanel', <SprintEngineBoardPanel workspaceId={workspaceId} />)
        case 'sprintengine-project':
          return timedPanel('SprintEngineBoardPanel', <SprintEngineBoardPanel workspaceId={workspaceId} fixedView="project" />)
        case 'sprintengine-map':
          return timedPanel('SprintEngineBoardPanel', <SprintEngineBoardPanel workspaceId={workspaceId} fixedView="map" />)
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
        case 'mobile-companion':
          return timedPanel('MobileCompanionPanel', <MobileCompanionPanel />)
        default:
          return <div className="h-full bg-[#08090b]" />
      }
    },
    [onStartFuturePlan, workspaceId]
  )

  const cleanupNode = useCallback(
    (node: TabNode) => {
      const config = node.getConfig() as { agentId?: string; terminalId?: string; filePath?: string } | undefined
      if (node.getComponent() === 'file-editor') {
        if (config?.filePath) closeFile(workspaceId, config.filePath)
        return
      }

      if (node.getComponent() === 'agent') {
        const agentId = config?.agentId ?? node.getId()
        const agent = workspace.agents[agentId]
        const sessionId = agent?.cliSessionId
        if (sessionId) void window.api.terminalKill(sessionId).catch(() => {})
        if (agent?.kind === 'sprintengine') setSprintEngineAutoEnabled(workspaceId, false)
        updateAgent(workspaceId, agentId, {
          cliStartRequested: false,
          cliHasLaunched: false,
          cliOnboardingPromptSent: false,
          cliResumeAvailable: false,
        })
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
    cleanupNode(node)
    modelRef.current?.doAction(Actions.deleteTab(node.getId()))
  }, [cleanupNode])

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
      cleanupNode(child)
      modelRef.current?.doAction(Actions.deleteTab(child.getId()))
    })
  }, [cleanupNode])

  const hideTab = useCallback((node: TabNode) => {
    hideTabWithoutCleanupRef.current.add(node.getId())
    modelRef.current?.doAction(Actions.deleteTab(node.getId()))
  }, [])

  const showTabContextMenu = useCallback(async (event: React.MouseEvent, node: TabNode) => {
    event.preventDefault()
    event.stopPropagation()

    const parent = node.getParent()
    const otherClosableTabs = parent instanceof TabSetNode
      ? parent.getChildren().filter((child) => child instanceof TabNode && child.getId() !== node.getId() && child.isEnableClose())
      : []

    const command = await window.api.showContextMenu([
      { id: 'hide-tab', label: 'Hide Tab', enabled: node.getComponent() === 'agent' },
      { id: 'close-other-tabs', label: 'Close Other Tabs', enabled: otherClosableTabs.length > 0 },
    ])

    if (command === 'hide-tab') {
      hideTab(node)
    }
    if (command === 'close-other-tabs') {
      closeOtherTabsInSet(node)
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
      const tabContent = (
        <span
          className="min-w-0 truncate"
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
        if (componentId === 'watchtower-panel' || componentId === 'switchboard-board') {
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

      const config = node.getConfig() as { agentId?: string } | undefined
      const agentId = config?.agentId ?? node.getId()
      const agent = workspace.agents[agentId]
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
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] text-[#9a9aa2]"
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

      if (activityDot) {
        renderValues.content = (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            {tabContent}
            <StatusDot tone={activityDot.tone} label={activityDot.label} />
          </span>
        )
      } else {
        renderValues.content = tabContent
      }
    },
    [commitRename, renameValue, renamingTabId, showTabContextMenu, startRename, workspace.agents, workspace.editorState?.openFiles, workspace.sprintEngineState]
  )

  return (
    <div className="relative h-full" onMouseDownCapture={handleMouseDownCapture}>
      <Layout
        model={modelRef.current}
        factory={factory}
        onAction={handleAction}
        onAuxMouseClick={handleAuxMouseClick}
        onRenderTab={renderTab}
        onModelChange={(model) => {
          updateLayout(workspaceId, model.toJson())
        }}
      />
    </div>
  )
}

export default React.memo(WorkspaceLayout)
