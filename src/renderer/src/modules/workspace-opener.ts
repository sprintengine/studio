import type { RegisteredWorkspaceTypeDefinition } from './renderer-host'

/** Shell-owned marker, separated from each type's own application data. */
export function firstWorkspaceOpenedKey(typeId: string): string {
  return `studio:workspace-opened:${typeId}`
}

export type WorkspaceOpenerPorts = {
  ready: Promise<void>
  types(): RegisteredWorkspaceTypeDefinition[]
  enabled(moduleId: string): boolean
  isPrimaryWindow(): boolean
  findWorkspace(typeId: string): string | undefined
  createWorkspace(type: RegisteredWorkspaceTypeDefinition): string
  focusWorkspace(workspaceId: string): void
  wasOpened(moduleId: string, key: string): boolean
  markOpened(moduleId: string, key: string): void
  onError(typeId: string, error: unknown): void
}

export function createWorkspaceOpener(ports: WorkspaceOpenerPorts) {
  const pending = new Map<string, Promise<string>>()
  const attempted = new Set<string>()

  function open(typeId: string): Promise<string> {
    const existing = pending.get(typeId)
    if (existing) return existing
    const opening = (async () => {
      await ports.ready
      const type = ports.types().find((entry) => entry.id === typeId)
      if (!type || !ports.enabled(type.moduleId)) {
        throw new Error(`Workspace type "${typeId}" is unavailable or disabled.`)
      }
      if (type.creationStep || type.createWorkspace) {
        throw new Error(`Workspace type "${typeId}" requires setup and cannot be opened without configuration.`)
      }
      const id = ports.findWorkspace(typeId) ?? ports.createWorkspace(type)
      ports.focusWorkspace(id)
      ports.markOpened(type.moduleId, firstWorkspaceOpenedKey(typeId))
      return id
    })()
    pending.set(typeId, opening)
    // Clear on both outcomes without manufacturing an unhandled rejection.
    void opening.then(() => pending.delete(typeId), () => pending.delete(typeId))
    return opening
  }

  async function openFirstLoads(): Promise<void> {
    await ports.ready
    // Only the primary renderer creates automatically; detached windows load
    // the same module bundles and must never independently mint their own row.
    if (!ports.isPrimaryWindow()) return
    for (const type of ports.types()) {
      if (!type.openOnFirstLoad || !ports.enabled(type.moduleId)) continue
      const key = firstWorkspaceOpenedKey(type.id)
      if (ports.wasOpened(type.moduleId, key) || attempted.has(type.id)) continue
      // Guard reentrant store notifications before any workspace mutation.
      attempted.add(type.id)
      try {
        await open(type.id)
      } catch (error) {
        ports.onError(type.id, error)
      }
    }
  }

  return { open, openFirstLoads }
}
