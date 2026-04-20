import React, { useCallback, useEffect, useRef } from 'react'
import { Layout, Model, TabNode } from 'flexlayout-react'
import 'flexlayout-react/style/dark.css'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { registerModel, unregisterModel } from '../../utils/modelRegistry'
import { buildSwarmAgentRoster } from '../../utils/swarm'
import AgentPanel from '../panels/AgentPanel'
import EditorPanel from '../panels/EditorPanel'
import FileExplorer from '../panels/FileExplorer'
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
      const config = node.getConfig() as { agentId?: string } | undefined

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
        case 'swarm':
          return <SwarmBoardPanel workspaceId={workspaceId} />
        case 'swarm-map':
          return <SwarmBoardPanel workspaceId={workspaceId} fixedView="map" />
        case 'swarm-kanban':
          return <SwarmBoardPanel workspaceId={workspaceId} fixedView="kanban" />
        default:
          return <div className="h-full bg-[#0f1012]" />
      }
    },
    [workspaceId]
  )

  return (
    <div className="relative h-full">
      <Layout
        model={modelRef.current}
        factory={factory}
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

          buildSwarmAgentRoster(workspace.swarmState.roleCounts).forEach((agent) => {
            const agentState = workspace.agents[agent.id]
            if (!agentState?.cliStartRequested || liveAgentTabs.has(agent.id)) return
            updateAgent(workspaceId, agent.id, {
              cliStartRequested: false,
              cliHasLaunched: false,
              cliOnboardingPromptSent: false,
              cliPlanApprovedPromptSent: false,
            })
          })
        }}
      />
    </div>
  )
}
