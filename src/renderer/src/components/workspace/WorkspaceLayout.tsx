import React, { useCallback, useEffect, useRef } from 'react'
import { Actions, Layout, Model, TabNode, TabSetNode, type Action } from 'flexlayout-react'
import 'flexlayout-react/style/dark.css'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { registerModel, unregisterModel } from '../../utils/modelRegistry'
import { buildSwarmAgentRosterForState } from '../../utils/swarm'
import AgentPanel from '../panels/AgentPanel'
import EditorPanel from '../panels/EditorPanel'
import FileExplorer from '../panels/FileExplorer'
import PlainTerminalPanel from '../panels/PlainTerminalPanel'
import SwarmBoardPanel from '../panels/SwarmBoardPanel'

interface Props {
  workspaceId: string
}

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
        case 'terminal':
          return (
            <PlainTerminalPanel
              workspaceId={workspaceId}
              terminalId={config?.terminalId ?? node.getId()}
            />
          )
        case 'swarm':
          return <SwarmBoardPanel workspaceId={workspaceId} />
        case 'swarm-map':
          return <SwarmBoardPanel workspaceId={workspaceId} fixedView="map" />
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

  return (
    <div className="relative h-full">
      <Layout
        model={modelRef.current}
        factory={factory}
        onAction={handleAction}
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
