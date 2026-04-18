import React, { useCallback, useRef } from 'react'
import { Layout, Model, TabNode } from 'flexlayout-react'
import 'flexlayout-react/style/dark.css'
import { useWorkspaceStore } from '../../store/workspaceStore'
import AgentPanel from '../panels/AgentPanel'
import EditorPanel from '../panels/EditorPanel'
import FileExplorer from '../panels/FileExplorer'
import SwarmBar from './SwarmBar'

interface Props {
  workspaceId: string
}

export default function WorkspaceLayout({ workspaceId }: Props) {
  const workspace    = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const updateLayout = useWorkspaceStore((s) => s.updateLayout)
  // Keep a stable Model instance per workspace — re-creating it destroys drag/resize state
  const modelRef = useRef<Model | null>(null)

  if (!workspace) return null
  if (!modelRef.current) {
    modelRef.current = Model.fromJson(workspace.layoutModel)
  }

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
          return <FileExplorer />
        default:
          return <div className="h-full bg-zinc-950" />
      }
    },
    [workspaceId]
  )

  return (
    <div className="flex flex-col h-full">
      <SwarmBar workspaceId={workspaceId} />
      <div className="relative flex-1 min-h-0">
        <Layout
          model={modelRef.current}
          factory={factory}
          onModelChange={(model) => updateLayout(workspaceId, model.toJson())}
        />
      </div>
    </div>
  )
}
