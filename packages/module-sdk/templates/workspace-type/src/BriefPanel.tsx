import { useEffect, useState } from 'react'

import type { ModuleWorkspaceView, RendererHost, WorkspacePanelProps } from '@sprintengine/module-sdk'
import { EmptyState, Field, Input, PanelHeader } from '@sprintengine/module-sdk/ui'

export type Brief = { goal: string; createdAt: string }

const isBrief = (value: unknown): value is Brief =>
  typeof value === 'object' && value !== null && typeof (value as Brief).goal === 'string'

// Per-workspace state (`getWorkspaceModuleState`) is this module's own entry
// on the workspace: saved with it, synced across windows, invisible to other
// modules. `undefined` is "not known yet", never "deleted" — the shell may not
// have loaded workspaces when a panel first renders.
export function createBriefPanel(host: RendererHost) {
  return function BriefPanel({ workspaceId }: WorkspacePanelProps) {
    const stored = host.getWorkspaceModuleState(workspaceId)
    const [goal, setGoal] = useState(isBrief(stored) ? stored.goal : '')
    const [workspace, setWorkspace] = useState<ModuleWorkspaceView | null>(null)

    useEffect(() => {
      let live = true
      void host.getWorkspace(workspaceId).then((view) => {
        if (live) setWorkspace(view)
      })
      return () => {
        live = false
      }
    }, [workspaceId])

    const save = () => {
      const current = host.getWorkspaceModuleState(workspaceId)
      host.setWorkspaceModuleState(workspaceId, { ...(isBrief(current) ? current : {}), goal: goal.trim() })
    }

    if (!isBrief(stored) && goal === '') {
      return <EmptyState title="No goal yet" body="Create a {{displayName}} workspace to give it one." />
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}>
        <PanelHeader title={workspace?.name ?? 'Brief'} subtitle={workspace?.folderPath ?? undefined} />
        <Field label="Goal" htmlFor={`{{id}}-goal-${workspaceId}`}>
          <Input
            id={`{{id}}-goal-${workspaceId}`}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            onBlur={save}
            fullWidth
          />
        </Field>
      </div>
    )
  }
}
