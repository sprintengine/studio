import type { AutomationRendererRequest, AutomationRendererResponse } from '../shared/automation'
import type { WorkspaceSyncSnapshot } from '../shared/workspace-sync'
import type { Workspace } from '../renderer/src/types/workspace'

// Shared "create a workspace and confirm it on the bus" core, used by both the
// automation `workspace.create` tool and the capability-module WorkspaceService.
// Workspace construction is renderer-owned domain logic, so creation is
// delegated to the primary renderer (the same store action the UI runs) and is
// then confirmed against the workspace-sync snapshot before success is reported
// — a caller never gets back an id it cannot observe. Keeping one copy of the
// delegate-then-confirm loop means the timeout, poll interval, and the
// unverified-creation message can't drift between the two callers.

export const WORKSPACE_CREATE_CONFIRM_TIMEOUT_MS = 7_000
const CONFIRM_POLL_INTERVAL_MS = 150

export type WorkspaceCreateInput = {
  name?: string
  folderPath?: string
  templateId?: string
}

export type WorkspaceCreateOutcome =
  | { ok: true; workspaceId: string; workspace: Workspace }
  | { ok: false; code: string; message: string }

export type WorkspaceCreateDeps = {
  delegateToRenderer(request: AutomationRendererRequest): Promise<AutomationRendererResponse>
  getWorkspaceSyncSnapshot(): WorkspaceSyncSnapshot
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export async function createWorkspaceConfirmed(
  input: WorkspaceCreateInput,
  deps: WorkspaceCreateDeps
): Promise<WorkspaceCreateOutcome> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  const findWorkspace = (id: string): Workspace | null =>
    deps.getWorkspaceSyncSnapshot().state.workspaces.find((candidate) => candidate.id === id) ?? null

  const delegated = await deps.delegateToRenderer({
    kind: 'workspace.create',
    name: optionalString(input.name),
    folderPath: optionalString(input.folderPath),
    templateId: optionalString(input.templateId),
  })
  if (!delegated.ok) return { ok: false, code: delegated.code, message: delegated.message }

  const deadline = now() + WORKSPACE_CREATE_CONFIRM_TIMEOUT_MS
  for (;;) {
    const found = findWorkspace(delegated.workspaceId)
    if (found) return { ok: true, workspaceId: delegated.workspaceId, workspace: found }
    if (now() >= deadline) {
      return {
        ok: false,
        code: 'bus_confirmation_timeout',
        message:
          `The renderer created workspace "${delegated.workspaceId}" but it was not observed on the `
          + `workspace-sync bus within ${WORKSPACE_CREATE_CONFIRM_TIMEOUT_MS}ms; treat the creation as unverified.`,
      }
    }
    await sleep(CONFIRM_POLL_INTERVAL_MS)
  }
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}
