import React, { Suspense, type ReactNode } from 'react'

import type { MountedWorkspaceTypeSupervisor } from './workspace-type-supervisors'

// Crash + chrome isolation for module workspace-type supervisors. Supervisors
// are render-nothing logic components, but the shell must not trust that:
// a throwing third-party supervisor is contained here (never unwinding the
// WorkspaceManager tree into a white window), and any visible output is
// neutralized by the display:none host so module code cannot draw into shell
// chrome. Mirrors ModuleSettingsSectionHost's per-contribution boundary.
class SupervisorBoundary extends React.Component<{ supervisorKey: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: unknown): void {
    console.error(`[modules] workspace-type supervisor "${this.props.supervisorKey}" threw:`, error)
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

export function WorkspaceTypeSupervisorHost({ supervisor }: { supervisor: MountedWorkspaceTypeSupervisor }) {
  const SupervisorComponent = supervisor.Component
  return (
    <div style={{ display: 'none' }} aria-hidden="true">
      <SupervisorBoundary supervisorKey={supervisor.key}>
        <Suspense fallback={null}>
          <SupervisorComponent />
        </Suspense>
      </SupervisorBoundary>
    </div>
  )
}
