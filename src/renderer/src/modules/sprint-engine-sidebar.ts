import { SprintEngineMarkIcon } from '../components/AppIcons'
import { isCanceledSprintEngineRun, isCompletedSprintEngineRun } from '../utils/sprintengine'
import { sprintEngineRunContext, sprintEngineRunState } from '../store/slices/workspaceModuleState'
import type { WorkspaceTypeRowAction, WorkspaceTypeSidebarWorkspace } from './renderer-host'
import type { Workspace } from '../types/workspace'

// Sidebar status the Sprint workspace type registers (MC-2577). The four
// WorkspaceSidebar branches that used to switch on `mode === 'sprintengine'`
// — on-disk-state delete, cancel-sprint, the row mark, and the delete-path
// subtitle — live here so they vanish with the module.

export function SprintEngineRowMark(props: { className?: string }) {
  const className = [
    'icon-xs',
    'shrink-0',
    'text-[color:var(--tool-sprintengine-ink)]',
    props.className,
  ].filter(Boolean).join(' ')
  return SprintEngineMarkIcon({ className })
}

export function sprintEngineHasOnDiskState(workspace: WorkspaceTypeSidebarWorkspace): boolean {
  return Boolean(sprintEngineRunContext(workspace)?.teamDirectoryPath)
}

export function sprintEngineOnDiskStateDirectory(workspace: WorkspaceTypeSidebarWorkspace): string | null {
  return sprintEngineRunContext(workspace)?.teamDirectoryPath ?? null
}

export function isCancelableSprintEngineWorkspace(workspace: WorkspaceTypeSidebarWorkspace): boolean {
  if (workspace.mode !== 'sprintengine') return false
  if (!sprintEngineRunContext(workspace)?.statePath) return false
  const state = sprintEngineRunState(workspace)
  if (state && (isCanceledSprintEngineRun(state) || isCompletedSprintEngineRun(state))) return false
  const runtimeState = 'sprintEngineAutoState' in workspace
    ? (workspace as Workspace).sprintEngineAutoState?.runtimeState
    : undefined
  return runtimeState !== 'canceled' && runtimeState !== 'complete'
}

export const sprintEngineCancelRowAction: WorkspaceTypeRowAction = {
  id: 'cancel-sprint',
  label: 'Cancel sprint…',
  variant: 'danger',
  isVisible: isCancelableSprintEngineWorkspace,
  confirm: (workspace) => ({
    title: `Cancel sprint “${workspace.name}”?`,
    body: 'Running agents stop and every unfinished task is marked canceled. Finished work and the run branch are kept. This cannot be undone.',
    confirmLabel: 'Cancel sprint',
    cancelLabel: 'Keep running',
  }),
  async run(workspaceId) {
    const [
      { useWorkspaceStore },
      { sprintEngineIpc },
      { refreshSprintEngineWorkspaceProjection },
      { publishDiagnostic },
    ] = await Promise.all([
      import('../store/workspaceStore'),
      import('./sprint-engine-ipc'),
      import('../utils/sprintengineProjectionRefresh'),
      import('../utils/diagnostics'),
    ])
    const workspace = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspaceId)
    const statePath = (workspace ? sprintEngineRunContext(workspace) : null)?.statePath
    if (!workspace || !statePath) return
    try {
      const result = await sprintEngineIpc.cancelSprintEngineRun({ statePath })
      if (!result.ok) throw new Error(result.message ?? 'Canceling the sprint failed.')
      await refreshSprintEngineWorkspaceProjection({
        workspace,
        tokens: new Map(),
        cause: 'manual',
        force: true,
      })
    } catch (error) {
      await publishDiagnostic({
        level: 'warning',
        source: 'sprintengine',
        title: 'Cancel sprint failed',
        message: error instanceof Error ? error.message : String(error),
        workspaceId: workspace.id,
        workspaceName: workspace.name,
      })
    }
  },
}
