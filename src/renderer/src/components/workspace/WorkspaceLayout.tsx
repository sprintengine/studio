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
import type { AgentState, SwarmRuntimeAgentStatus } from '../../types/workspace'
import { registerModel, unregisterModel } from '../../utils/modelRegistry'
import { SpecialistActionIcon, StatusDot, SwarmRoleIcon } from '../AppIcons'
import AgentPanel from '../panels/AgentPanel'
import FileExplorer from '../panels/FileExplorer'

interface Props {
  workspaceId: string
}

const EditorPanel = React.lazy(() => import('../panels/EditorPanel'))
const GitPanel = React.lazy(() => import('../panels/GitPanel'))
const PlainTerminalPanel = React.lazy(() => import('../panels/PlainTerminalPanel'))
const SwarmBoardPanel = React.lazy(() => import('../panels/SwarmBoardPanel'))
const AGENT_TAB_NEEDS_INPUT_CLASS = 'agent-tab-needs-input'
type AgentTabActivity = 'needs-input' | 'running' | 'idle'

type AgentTabActivityDot = {
  tone: 'running' | 'needs-input'
  label: string
}

function agentTabActivity(
  agent: AgentState | undefined,
  runtimeStatus: SwarmRuntimeAgentStatus | undefined
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

function PanelLoadingFallback() {
  return (
    <div className="flex h-full items-center justify-center bg-[#08090b] text-[12px] font-mono text-[#6f7078]">
      Loading panel...
    </div>
  )
}

function WorkspaceLayout({ workspaceId }: Props) {
  const workspace    = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const updateLayout = useWorkspaceStore((s) => s.updateLayout)
  const updateAgent = useWorkspaceStore((s) => s.updateAgent)
  const setActiveFile = useWorkspaceStore((s) => s.setActiveFile)
  const closeFile = useWorkspaceStore((s) => s.closeFile)
  const setSwarmAutoEnabled = useWorkspaceStore((s) => s.setSwarmAutoEnabled)
  // Keep a stable Model instance per workspace — re-creating it destroys drag/resize state
  const modelRef = useRef<Model | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const skipNextRenameCommitRef = useRef(false)
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
      if (!(node instanceof TabNode) || node.getComponent() !== 'agent') return

      const config = node.getConfig() as { agentId?: string } | undefined
      const agentId = config?.agentId ?? node.getId()
      const agent = workspace.agents[agentId]
      const currentClassName = node.getClassName() ?? ''
      const classNames = currentClassName.split(/\s+/).filter(Boolean)
      const hasClass = classNames.includes(AGENT_TAB_NEEDS_INPUT_CLASS)
      const needsInput = workspace.swarmState?.swarmAgents[agentId]?.status === 'needs_input'
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
  }, [workspace.agents, workspace.swarmState?.swarmAgents])

  const factory = useCallback(
    (node: TabNode) => {
      const component = node.getComponent()
      const config = node.getConfig() as { agentId?: string; terminalId?: string; filePath?: string } | undefined

      switch (component) {
        case 'agent':
          return (
            <AgentPanel
              workspaceId={workspaceId}
              agentId={config?.agentId ?? node.getId()}
            />
          )
        case 'editor':
          return (
            <Suspense fallback={<PanelLoadingFallback />}>
              <EditorPanel workspaceId={workspaceId} />
            </Suspense>
          )
        case 'file-editor':
          return config?.filePath
            ? (
              <Suspense fallback={<PanelLoadingFallback />}>
                <EditorPanel workspaceId={workspaceId} filePath={config.filePath} />
              </Suspense>
            )
            : <div className="h-full bg-[#08090b]" />
        case 'explorer':
          return <FileExplorer workspaceId={workspaceId} />
        case 'git':
          return (
            <Suspense fallback={<PanelLoadingFallback />}>
              <GitPanel workspaceId={workspaceId} />
            </Suspense>
          )
        case 'terminal':
          return (
            <Suspense fallback={<PanelLoadingFallback />}>
              <PlainTerminalPanel
                workspaceId={workspaceId}
                terminalId={config?.terminalId ?? node.getId()}
              />
            </Suspense>
          )
        case 'swarm':
          return (
            <Suspense fallback={<PanelLoadingFallback />}>
              <SwarmBoardPanel workspaceId={workspaceId} />
            </Suspense>
          )
        case 'swarm-project':
          return (
            <Suspense fallback={<PanelLoadingFallback />}>
              <SwarmBoardPanel workspaceId={workspaceId} fixedView="project" />
            </Suspense>
          )
        case 'swarm-map':
          return (
            <Suspense fallback={<PanelLoadingFallback />}>
              <SwarmBoardPanel workspaceId={workspaceId} fixedView="map" />
            </Suspense>
          )
        case 'swarm-task-graph':
          return (
            <Suspense fallback={<PanelLoadingFallback />}>
              <SwarmBoardPanel workspaceId={workspaceId} fixedView="task-graph" />
            </Suspense>
          )
        case 'swarm-kanban':
          return (
            <Suspense fallback={<PanelLoadingFallback />}>
              <SwarmBoardPanel workspaceId={workspaceId} fixedView="kanban" />
            </Suspense>
          )
        default:
          return <div className="h-full bg-[#08090b]" />
      }
    },
    [workspaceId]
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
        if (agent?.kind === 'swarm') setSwarmAutoEnabled(workspaceId, false)
        updateAgent(workspaceId, agentId, {
          cliStartRequested: false,
          cliHasLaunched: false,
          cliOnboardingPromptSent: false,
        })
        return
      }

      if (node.getComponent() === 'terminal') {
        const terminalId = config?.terminalId ?? node.getId()
        void window.api.terminalKill(`terminal-${terminalId}`).catch(() => {})
      }
    },
    [closeFile, setSwarmAutoEnabled, updateAgent, workspace.agents, workspaceId]
  )

  const handleAction = useCallback(
    (action: Action) => {
      if (action.type === Actions.DELETE_TAB) {
        const node = modelRef.current?.getNodeById(action.data.node)
        if (node instanceof TabNode) cleanupNode(node)
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
        renderValues.content = tabContent
        return
      }

      const config = node.getConfig() as { agentId?: string } | undefined
      const agentId = config?.agentId ?? node.getId()
      const agent = workspace.agents[agentId]
      const runtimeAgent = workspace.swarmState?.swarmAgents[agentId]
      const activity = agentTabActivity(agent, runtimeAgent?.status)
      const currentTaskId = runtimeAgent?.currentTaskId
      const activityDot = agentTabActivityDot(activity, currentTaskId)
      const specialist = agent?.kind === 'specialist' && agent.specialistId
        ? getSpecialistAction(agent.specialistId)
        : null
      const swarmRole = agent?.kind === 'swarm' ? runtimeAgent?.role : null

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
      } else if (swarmRole) {
        renderValues.leading = (
          <span
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] text-[#9a9aa2]"
            title={`${swarmRole} swarm agent`}
            aria-label={`${swarmRole} swarm agent`}
          >
            <SwarmRoleIcon role={swarmRole} className="h-3.5 w-3.5" />
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
    [commitRename, renameValue, renamingTabId, startRename, workspace.agents, workspace.editorState?.openFiles, workspace.swarmState]
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
