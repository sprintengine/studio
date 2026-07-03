import { useEffect } from 'react'
import type { SprintEngineCliPermissionPreset } from '../../../types/workspace'
import { CreationBackdrop } from '../../backdrops/CreationBackdrop'
import AgentComposer, {
  type AgentComposerConfirm,
  type AgentComposerSelection,
  type ComposerProjectOption,
} from './AgentComposer'

export type NewChatPanelInitialState = {
  // Folder the chat will be created in; null inherits the active workspace's
  // folder at spawn time. `folderLabel` is the display name for the scoping chip.
  folderPath: string | null
  folderLabel: string | null
}

interface Props {
  initialState: NewChatPanelInitialState
  // Project choices for the header chip (the projects open in Multicode) and
  // the host handlers that reassign the panel's folder scope.
  projectOptions: ComposerProjectOption[]
  onSelectProject: (path: string) => void
  onBrowseProject: () => void
  // The remembered agent, preselected on open.
  initialSelection: AgentComposerSelection
  permissionPreset: SprintEngineCliPermissionPreset
  onChangePermissionPreset: (preset: SprintEngineCliPermissionPreset) => void
  debugMode: boolean
  onChangeDebugMode: (next: boolean) => void
  // Fired only when the user starts the chat; the host performs the spawn.
  onConfirm: (confirm: AgentComposerConfirm) => void
  onClose: () => void
}

// Pre-creation host for the New Chat flow. Mirrors NewWorkspacePanel: it fills
// the workspace canvas, owns no persistence, and creates nothing — the wrapped
// AgentComposer emits a confirm the host maps to a spawn, or a close that
// discards. Escape (handled here) and the composer's own close both discard.
export default function NewChatPanel({
  initialState,
  projectOptions,
  onSelectProject,
  onBrowseProject,
  initialSelection,
  permissionPreset,
  onChangePermissionPreset,
  debugMode,
  onChangeDebugMode,
  onConfirm,
  onClose,
}: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="absolute inset-0 z-10 isolate flex items-start justify-center overflow-auto bg-[color:var(--bg-app)]">
      <CreationBackdrop surface="workspace" />
      <div className="w-full max-w-[760px] px-6 pb-16 pt-[7vh]">
        {/* Tall enough to show the whole roster without an inner scroll on a
            normal display; the viewport clamp keeps small windows usable. */}
        <div className="h-[min(860px,82vh)] overflow-hidden rounded-lg border border-[color:var(--border-default)]">
          <AgentComposer
            folderPath={initialState.folderPath}
            folderLabel={initialState.folderLabel}
            projectOptions={projectOptions}
            onSelectProject={onSelectProject}
            onBrowseProject={onBrowseProject}
            initialSelection={initialSelection}
            permissionPreset={permissionPreset}
            onChangePermissionPreset={onChangePermissionPreset}
            debugMode={debugMode}
            onChangeDebugMode={onChangeDebugMode}
            onConfirm={onConfirm}
            onClose={onClose}
          />
        </div>
      </div>
    </div>
  )
}
