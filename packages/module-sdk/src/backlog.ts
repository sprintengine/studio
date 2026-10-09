// The Backlog write API: change, create and annotate Backlog items from a
// module's `entry.main` or renderer, outside a Backlog action the person
// picked. Every write goes through the app's own Backlog service, in the same
// per-project lane its other writers use, so ids, file names and frontmatter
// follow the app's rules and two writers never race. A module never writes an
// item's file itself.

import type { BacklogItemLink, BacklogItemStatus, BacklogItemView, MainHost, ServiceToken } from './index.js'

export type ModuleBacklogErrorCode =
  | 'permission_missing'
  | 'invalid_input'
  | 'unknown_workspace'
  | 'workspace_folder_missing'
  | 'not_found'
  | 'backlog_unavailable'

export type ModuleBacklogResult<T extends object = object> =
  ({ ok: true } & T) | { ok: false; code: ModuleBacklogErrorCode; message: string }

/**
 * Where a workspace's Backlog lives. `root` is the absolute folder the item
 * files are in: `<workspace>/backlog` by default (`isDefault: true`), or the
 * folder the person pointed the Backlog at. `exists` is false when that folder
 * is not there (an unplugged drive, a Backlog repo not cloned yet).
 */
export type ModuleBacklogLocation = {
  root: string
  isDefault: boolean
  exists: boolean
}

/**
 * The triage axes to change. An axis left out is not touched; `null` clears it.
 * Values outside the app's vocabulary (difficulty `xs`…`xl`, criticality
 * `low`/`normal`/`high`/`critical`, risk `low`/`normal`/`high`) are refused.
 */
export type ModuleBacklogTriageInput = {
  difficulty?: string | null
  criticality?: string | null
  risk?: string | null
}

/**
 * A new item. `title` is required; `body` is the Markdown under the title.
 * `status` defaults to `idea`. `type`, `epic` (an epic's slug) and the triage
 * axes are optional; a value the app does not know is refused, never guessed.
 */
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

/**
 * The item `create` wrote. `id` and `relativePath` are the `BacklogItemView`
 * id the item lists under; `path` is its file. `numericId` is the number the
 * app allocated (`displayId` composes it with the workspace's key, `MC-240`).
 */
export type ModuleBacklogCreated = {
  id: string
  relativePath: string
  path: string
  numericId?: number
  displayId?: string
}

/**
 * A link to record on an item. The host stamps your module's id as its owner;
 * a `moduleId` naming another module is refused.
 */
export type ModuleBacklogLinkInput = Omit<BacklogItemLink, 'moduleId'> & { moduleId?: string }

/**
 * The Backlog for a module's `entry.main`, obtained via
 * `getBacklogService(host)`. `itemId` is a `BacklogItemView.id` (the item's
 * logical path, `backlog/…`). Expected failures come back as results, never
 * throws. Reads need the `backlog.read` permission and writes `backlog.write`;
 * the host checks both on every call.
 */
export type ModuleBacklogService = {
  /** The workspace's items, read from disk now. */
  list(workspaceId: string): Promise<ModuleBacklogResult<{ items: BacklogItemView[] }>>
  getLocation(workspaceId: string): Promise<ModuleBacklogResult<{ location: ModuleBacklogLocation }>>
  create(workspaceId: string, input: ModuleBacklogCreateInput): Promise<ModuleBacklogResult<ModuleBacklogCreated>>
  updateStatus(workspaceId: string, itemId: string, status: BacklogItemStatus): Promise<ModuleBacklogResult>
  updateTriage(workspaceId: string, itemId: string, triage: ModuleBacklogTriageInput): Promise<ModuleBacklogResult>
  /** Add a link, or replace the one with the same `id`. */
  addLink(workspaceId: string, itemId: string, link: ModuleBacklogLinkInput): Promise<ModuleBacklogResult>
  /** Replace your module's entry in the item's `metadata` (keyed by your module id). */
  updateModuleMetadata(workspaceId: string, itemId: string, value: unknown): Promise<ModuleBacklogResult>
}

type ModuleBacklogRegistry = {
  [K in keyof ModuleBacklogService]: (
    moduleId: string,
    ...args: Parameters<ModuleBacklogService[K]>
  ) => ReturnType<ModuleBacklogService[K]>
}

// A literal rather than createServiceToken: index.ts re-exports this file, and
// a value import back into it would be a cycle for nothing (a token is its key).
const backlogModuleServiceToken: ServiceToken<ModuleBacklogRegistry> = { key: 'backlog.module-service' }

/**
 * The scoped Backlog service for `host`'s module; closes over `host.moduleId`
 * like `getModuleStorage`. Provided by the agent-runtime core: declare
 * `dependsOn: ['agent-runtime']` (or resolve inside handlers) so registration
 * order cannot race the provider. `host.supports('backlog-write')` says
 * whether this host has it.
 */
export function getBacklogService(host: MainHost): ModuleBacklogService {
  const registry = host.requireService(backlogModuleServiceToken)
  const moduleId = host.moduleId
  return {
    list: (workspaceId) => registry.list(moduleId, workspaceId),
    getLocation: (workspaceId) => registry.getLocation(moduleId, workspaceId),
    create: (workspaceId, input) => registry.create(moduleId, workspaceId, input),
    updateStatus: (workspaceId, itemId, status) => registry.updateStatus(moduleId, workspaceId, itemId, status),
    updateTriage: (workspaceId, itemId, triage) => registry.updateTriage(moduleId, workspaceId, itemId, triage),
    addLink: (workspaceId, itemId, link) => registry.addLink(moduleId, workspaceId, itemId, link),
    updateModuleMetadata: (workspaceId, itemId, value) =>
      registry.updateModuleMetadata(moduleId, workspaceId, itemId, value),
  }
}

/**
 * Why a `watchBacklogItems` could not deliver. The watch stays open: a later
 * readable scan calls your callback again, so `onError` may fire more than
 * once and is a state to show, not a reason to unsubscribe.
 */
export type BacklogWatchError = {
  code: 'workspace_folder_missing' | 'unknown_workspace' | 'scan_failed'
  message: string
}

export type BacklogWatchOptions = {
  onError?: (error: BacklogWatchError) => void
}
