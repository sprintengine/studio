import React, { useCallback, useEffect, useRef } from 'react'
import { Actions, Layout, Model, TabNode, TabSetNode, type Action, type ITabRenderValues } from 'flexlayout-react'
import 'flexlayout-react/style/dark.css'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { registerModel, unregisterModel } from '../../utils/modelRegistry'
import { buildSwarmAgentRosterForState } from '../../utils/swarm'
import CliIcon from '../CliIcon'
import AgentPanel from '../panels/AgentPanel'
import EditorPanel from '../panels/EditorPanel'
import FileExplorer from '../panels/FileExplorer'
import GitPanel from '../panels/GitPanel'
import PlainTerminalPanel from '../panels/PlainTerminalPanel'
import SwarmBoardPanel from '../panels/SwarmBoardPanel'

interface Props {
  workspaceId: string
}

const AGENT_TAB_NEEDS_INPUT_CLASS = 'agent-tab-needs-input'

export default function WorkspaceLayout({ workspaceId }: Props) {
  const workspace    = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const updateLayout = useWorkspaceStore((s) => s.updateLayout)
  const updateAgent = useWorkspaceStore((s) => s.updateAgent)
  // Keep a stable Model instance per workspace — re-creating it destroys drag/resize state
  const modelRef = useRef<Model | null>(null)

  if (!workspace) return null
  if (!modelRef.current) {
    modelRef.current = Model.fromJson(workspace.layoutModel)
  }

  useEffect(() => {
    if (modelRef.current) registerModel(workspaceId, modelRef.current)
    return () => unregisterModel(workspaceId)
  }, [workspaceId])

  useEffect(() => {
    const model = modelRef.current
    if (!model) return

    model.visitNodes((node) => {
      if (!(node instanceof TabNode) || node.getComponent() !== 'agent') return

      const config = node.getConfig() as { agentId?: string } | undefined
      const agentId = config?.agentId ?? node.getId()
      const currentClassName = node.getClassName() ?? ''
      const classNames = currentClassName.split(/\s+/).filter(Boolean)
      const hasClass = classNames.includes(AGENT_TAB_NEEDS_INPUT_CLASS)
      const needsInput = workspace.swarmState?.swarmAgents[agentId]?.status === 'needs_input'

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
  }, [workspace.swarmState?.swarmAgents])

  const factory = useCallback(
    (node: TabNode) => {
      const component = node.getComponent()
      const config = node.getConfig() as { agentId?: string; terminalId?: string } | undefined

      switch (component) {
        case 'agent':
          return (
            <AgentPanel
              workspaceId={workspaceId}
              agentId={config?.agentId ?? node.getId()}
            />
          )
        case 'editor':
          return <EditorPanel workspaceId={workspaceId} />
        case 'explorer':
          return <FileExplorer workspaceId={workspaceId} />
        case 'git':
          return <GitPanel workspaceId={workspaceId} />
        case 'terminal':
          return (
            <PlainTerminalPanel
              workspaceId={workspaceId}
              terminalId={config?.terminalId ?? node.getId()}
            />
          )
        case 'swarm':
          return <SwarmBoardPanel workspaceId={workspaceId} />
        case 'swarm-project':
          return <SwarmBoardPanel workspaceId={workspaceId} fixedView="project" />
        case 'swarm-map':
          return <SwarmBoardPanel workspaceId={workspaceId} fixedView="map" />
        case 'swarm-task-graph':
          return <SwarmBoardPanel workspaceId={workspaceId} fixedView="task-graph" />
        case 'swarm-kanban':
          return <SwarmBoardPanel workspaceId={workspaceId} fixedView="kanban" />
        default:
          return <div className="h-full bg-[#08090b]" />
      }
    },
    [workspaceId]
  )

  const killTerminalForNode = useCallback(
    (node: TabNode) => {
      const config = node.getConfig() as { agentId?: string; terminalId?: string } | undefined
      if (node.getComponent() === 'agent') {
        const agentId = config?.agentId ?? node.getId()
        const sessionId = workspace.agents[agentId]?.cliSessionId
        if (sessionId) void window.api.terminalKill(sessionId).catch(() => {})
        return
      }

      if (node.getComponent() === 'terminal') {
        const terminalId = config?.terminalId ?? node.getId()
        void window.api.terminalKill(`terminal-${terminalId}`).catch(() => {})
      }
    },
    [workspace.agents]
  )

  const handleAction = useCallback(
    (action: Action) => {
      if (action.type === Actions.DELETE_TAB) {
        const node = modelRef.current?.getNodeById(action.data.node)
        if (node instanceof TabNode) killTerminalForNode(node)
      }

      if (action.type === Actions.DELETE_TABSET) {
        const node = modelRef.current?.getNodeById(action.data.node)
        if (node instanceof TabSetNode) {
          node.getChildren().forEach((child) => {
            if (child instanceof TabNode && child.isEnableClose()) {
              killTerminalForNode(child)
            }
          })
        }
      }

      return action
    },
    [killTerminalForNode]
  )

  const renderTab = useCallback(
    (node: TabNode, renderValues: ITabRenderValues) => {
      if (node.getComponent() !== 'agent') return

      const config = node.getConfig() as { agentId?: string } | undefined
      const agentId = config?.agentId ?? node.getId()
      const agent = workspace.agents[agentId]
      const cli = agent?.cli ?? 'codex'
      const cliLabel = cli === 'codex' ? 'Codex' : 'Claude'
      const needsInput = workspace.swarmState?.swarmAgents[agentId]?.status === 'needs_input'
      const currentTaskId = workspace.swarmState?.swarmAgents[agentId]?.currentTaskId

      renderValues.leading = (
        <span
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] ${needsInput ? 'text-[#ffe0a3]' : 'text-[#9a9aa2]'}`}
          title={`${cliLabel} CLI`}
          aria-label={`${cliLabel} CLI`}
        >
          <CliIcon cli={cli} className="h-3.5 w-3.5" />
        </span>
      )

      if (needsInput) {
        renderValues.buttons.unshift(
          <span
            key="needs-input"
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#ffbf2f] shadow-[0_0_8px_rgba(255,191,47,0.85)]"
            title={currentTaskId ? `Needs input on ${currentTaskId}` : 'Needs input'}
            aria-label={currentTaskId ? `Needs input on ${currentTaskId}` : 'Needs input'}
          />
        )
      }
    },
    [workspace.agents, workspace.swarmState]
  )

  return (
    <div className="relative h-full">
      <Layout
        model={modelRef.current}
        factory={factory}
        onAction={handleAction}
        onRenderTab={renderTab}
        onModelChange={(model) => {
          updateLayout(workspaceId, model.toJson())

          if (workspace.mode !== 'swarm' || !workspace.swarmState) return

          const liveAgentTabs = new Set<string>()
          model.visitNodes((node) => {
            if (!(node instanceof TabNode) || node.getComponent() !== 'agent') return
            const config = node.getConfig() as { agentId?: string } | undefined
            const agentId = config?.agentId ?? node.getId()
            liveAgentTabs.add(agentId)
          })

          buildSwarmAgentRosterForState(workspace.swarmState).forEach((agent) => {
            const agentState = workspace.agents[agent.id]
            if (!agentState?.cliStartRequested || liveAgentTabs.has(agent.id)) return
            updateAgent(workspaceId, agent.id, {
              cliStartRequested: false,
              cliHasLaunched: false,
              cliOnboardingPromptSent: false,
            })
          })
        }}
      />
    </div>
  )
}
