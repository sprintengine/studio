import { useEffect, useState } from 'react'

import type { ModuleWorkspaceView, RendererHost } from '@sprintengine/module-sdk'
import { EmptyState, RowButton, Section } from '@sprintengine/module-sdk/ui'
import { GlobalSurfaceShell, SurfaceCanvasState, useSurfaceBackNav } from '@sprintengine/module-sdk/surface'

// The host's door shell gives the surface the app's own title bar, back
// affordance and rail gutter; the rail and canvas inside are this module's.
// `watchWorkspaces` fires with the current list at once, then on change, so
// the rail never needs a loading state of its own after the first call.
export function createSurface(host: RendererHost) {
  return function Surface() {
    const { onBack, canGoBack } = useSurfaceBackNav()
    const [workspaces, setWorkspaces] = useState<ModuleWorkspaceView[] | null>(null)
    const [selectedId, setSelectedId] = useState<string | null>(null)

    useEffect(() => host.watchWorkspaces(setWorkspaces), [])

    const selected = workspaces?.find((workspace) => workspace.id === selectedId) ?? null

    const rail = (
      <Section title="Workspaces" count={workspaces?.length}>
        {(workspaces ?? []).map((workspace) => (
          <RowButton
            key={workspace.id}
            selected={workspace.id === selectedId}
            onClick={() => setSelectedId(workspace.id)}
          >
            {workspace.name}
          </RowButton>
        ))}
      </Section>
    )

    return (
      <GlobalSurfaceShell
        ariaLabel="{{displayName}}"
        bar={{ title: '{{displayName}}' }}
        rail={rail}
        onBack={onBack}
        canGoBack={canGoBack}
      >
        {workspaces === null ? (
          <SurfaceCanvasState kind="loading" label="Reading workspaces" />
        ) : selected === null ? (
          <EmptyState title="Pick a workspace" body="Choose one on the left to see where it lives." />
        ) : (
          <Section title={selected.name}>
            <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 16px', margin: 0 }}>
              <dt style={{ color: 'var(--text-muted)' }}>Folder</dt>
              <dd style={{ margin: 0 }}>{selected.folderPath ?? 'None (a folderless workspace)'}</dd>
              <dt style={{ color: 'var(--text-muted)' }}>Type</dt>
              <dd style={{ margin: 0 }}>{selected.mode}</dd>
            </dl>
          </Section>
        )}
      </GlobalSurfaceShell>
    )
  }
}
