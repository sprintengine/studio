import type { AutomationRendererRequest, AutomationRendererResponse } from '../../shared/automation'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'

// The workspace-creation service capability modules consume via the host
// service bridge (WorkspaceServiceToken). It mirrors the automation
// `workspace.create` tool exactly: a creation is delegated to the primary
// renderer (the same store action the UI runs — workspace construction is
// renderer-owned domain logic) and is confirmed against the workspace-sync bus
// before success is reported, so a module never gets an unverified id back.

const CREATE_CONFIRM_TIMEOUT_MS = 7_000
const CONFIRM_POLL_INTERVAL_MS = 150

export type ModuleWorkspaceCreateInput = {
  name?: string
  folderPath?: string
  templateId?: string
}

export type ModuleWorkspaceCreateResult =
  | { ok: true; workspaceId: string }
  | { ok: false; code: string; message: string }

export type ModuleWorkspaceService = {
  create(input: ModuleWorkspaceCreateInput): Promise<ModuleWorkspaceCreateResult>
}

export type ModuleWorkspaceServiceBackends = {
  delegateToRenderer(request: AutomationRendererRequest): Promise<AutomationRendererResponse>
  getWorkspaceSyncSnapshot(): WorkspaceSyncSnapshot
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export function createModuleWorkspaceService(
  backends: ModuleWorkspaceServiceBackends
): ModuleWorkspaceService {
  const now = backends.now ?? Date.now
  const sleep = backends.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  function workspaceExists(workspaceId: string): boolean {
    return backends.getWorkspaceSyncSnapshot().state.workspaces.some((w) => w.id === workspaceId)
  }

  async function waitForWorkspace(workspaceId: string): Promise<boolean> {
    const deadline = now() + CREATE_CONFIRM_TIMEOUT_MS
    for (;;) {
      if (workspaceExists(workspaceId)) return true
      if (now() >= deadline) return false
      await sleep(CONFIRM_POLL_INTERVAL_MS)
    }
  }

  return {
    async create(input): Promise<ModuleWorkspaceCreateResult> {
      const delegated = await backends.delegateToRenderer({
        kind: 'workspace.create',
        name: optionalString(input.name),
        folderPath: optionalString(input.folderPath),
        templateId: optionalString(input.templateId),
      })
      if (!delegated.ok) return { ok: false, code: delegated.code, message: delegated.message }

      const confirmed = await waitForWorkspace(delegated.workspaceId)
      if (!confirmed) {
        return {
          ok: false,
          code: 'bus_confirmation_timeout',
          message:
            `The renderer created workspace "${delegated.workspaceId}" but it was not observed on the `
            + `workspace-sync bus within ${CREATE_CONFIRM_TIMEOUT_MS}ms; treat the creation as unverified.`,
        }
      }
      return { ok: true, workspaceId: delegated.workspaceId }
    },
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}
