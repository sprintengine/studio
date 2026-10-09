// The module-facing Backlog write contract: what a module's `entry.main`
// (getBacklogService) and renderer (the RendererHost Backlog write methods)
// reach, served by main/module-host/module-backlog.ts over the app's own
// Backlog service. The SDK mirrors these shapes by hand and the drift guard
// pins the two together. Node-free and type-only, so both tsconfig projects
// can import it.

import type { BacklogItem, BacklogItemLink, BacklogItemStatus } from '../backlog/scan'

export type ModuleBacklogErrorCode =
  | 'permission_missing'
  | 'invalid_input'
  | 'unknown_workspace'
  | 'workspace_folder_missing'
  | 'not_found'
  | 'backlog_unavailable'

export type ModuleBacklogResult<T extends object = object> =
  ({ ok: true } & T) | { ok: false; code: ModuleBacklogErrorCode; message: string }

export type ModuleBacklogLocation = {
  root: string
  isDefault: boolean
  exists: boolean
}

export type ModuleBacklogTriageInput = {
  difficulty?: string | null
  criticality?: string | null
  risk?: string | null
}

export type ModuleBacklogCreateInput = {
  title: string
  body?: string
  status?: BacklogItemStatus
  type?: string
  epic?: string
  difficulty?: string
  criticality?: string
  risk?: string
}

export type ModuleBacklogCreated = {
  id: string
  relativePath: string
  path: string
  numericId?: number
  displayId?: string
}

export type ModuleBacklogLinkInput = Omit<BacklogItemLink, 'moduleId'> & { moduleId?: string }

// `list` hands out the scan's own items, which carry more than the SDK's
// published `BacklogItemView` (the drift guard checks the one satisfies the
// other); everything else is restated exactly.
export type ModuleBacklogService = {
  list(workspaceId: string): Promise<ModuleBacklogResult<{ items: BacklogItem[] }>>
  getLocation(workspaceId: string): Promise<ModuleBacklogResult<{ location: ModuleBacklogLocation }>>
  create(workspaceId: string, input: ModuleBacklogCreateInput): Promise<ModuleBacklogResult<ModuleBacklogCreated>>
  updateStatus(workspaceId: string, itemId: string, status: BacklogItemStatus): Promise<ModuleBacklogResult>
  updateTriage(workspaceId: string, itemId: string, triage: ModuleBacklogTriageInput): Promise<ModuleBacklogResult>
  addLink(workspaceId: string, itemId: string, link: ModuleBacklogLinkInput): Promise<ModuleBacklogResult>
  updateModuleMetadata(workspaceId: string, itemId: string, value: unknown): Promise<ModuleBacklogResult>
}

// What the host provides under 'backlog.module-service': the service with the
// calling module's id first, which the SDK helper closes over.
export type ModuleBacklogRegistry = {
  [K in keyof ModuleBacklogService]: (
    moduleId: string,
    ...args: Parameters<ModuleBacklogService[K]>
  ) => ReturnType<ModuleBacklogService[K]>
}

export type BacklogWatchError = {
  code: 'workspace_folder_missing' | 'unknown_workspace' | 'scan_failed'
  message: string
}

export type BacklogWatchOptions = {
  onError?: (error: BacklogWatchError) => void
}
