import type { IpcMain, IpcMainInvokeEvent } from 'electron'

// Main-process host kernel. Replaces the static, central wiring in
// app-services.ts / register-*-ipc.ts with registries that capability modules
// register themselves into. Each module receives a scoped `MainHost` that
// carries its own id but shares the kernel's registries, so cross-module
// services and IPC ownership are tracked centrally.

export type IpcInvokeHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown | Promise<unknown>

export type StartupHook = () => void | Promise<void>
export type ShutdownHook = () => void | Promise<void>

/**
 * Typed handle for a service one module provides and others require, without
 * direct imports across module boundaries. Create one per service contract.
 */
export type ServiceToken<T> = { readonly key: string; readonly __type?: T }

export function createServiceToken<T>(key: string): ServiceToken<T> {
  return { key }
}

export type SidecarSpec = {
  id: string
  /** e.g. 'python', 'python-mcp', 'process'. Free-form; the SidecarHost interprets it. */
  kind: string
  /** Python module name or executable, depending on kind. */
  module?: string
  description?: string
}

export type MainHost = {
  /** The module currently registering. Useful for diagnostics and ownership. */
  readonly moduleId: string
  /**
   * Raw ipcMain, for first-party (trusted, in-process) modules that reuse
   * existing `registerXIpc(ipcMain)` functions. Prefer `registerIpc` for new
   * code so channel ownership is tracked and collisions are caught.
   */
  readonly ipcMain: IpcMain
  registerIpc(channel: string, handler: IpcInvokeHandler): void
  provideService<T>(token: ServiceToken<T>, factory: (host: MainHost) => T): T
  getService<T>(token: ServiceToken<T>): T | undefined
  requireService<T>(token: ServiceToken<T>): T
  onStartup(hook: StartupHook): void
  onShutdown(hook: ShutdownHook): void
  registerSidecar(spec: SidecarSpec): void
}

export type MainKernel = {
  /** A scoped host for the given module. Shares the kernel's registries. */
  hostFor(moduleId: string): MainHost
  /** channel -> owning module id, for diagnostics and collision reports. */
  ownedChannels(): ReadonlyMap<string, string>
  startupHooks(): ReadonlyArray<StartupHook>
  shutdownHooks(): ReadonlyArray<ShutdownHook>
  sidecars(): ReadonlyArray<SidecarSpec>
}

export function createMainKernel(ipcMain: IpcMain): MainKernel {
  const channels = new Map<string, string>()
  const services = new Map<string, unknown>()
  const startupHooks: StartupHook[] = []
  const shutdownHooks: ShutdownHook[] = []
  const sidecars: SidecarSpec[] = []

  function hostFor(moduleId: string): MainHost {
    return {
      moduleId,
      ipcMain,
      registerIpc(channel, handler) {
        const existingOwner = channels.get(channel)
        if (existingOwner) {
          throw new Error(
            `IPC channel "${channel}" is already registered by module "${existingOwner}".`
          )
        }
        channels.set(channel, moduleId)
        ipcMain.handle(channel, handler)
      },
      provideService<T>(token: ServiceToken<T>, factory: (host: MainHost) => T): T {
        if (services.has(token.key)) {
          throw new Error(
            `Service "${token.key}" is already provided; module "${moduleId}" tried to provide it again.`
          )
        }
        const instance = factory(this)
        services.set(token.key, instance)
        return instance
      },
      getService<T>(token: ServiceToken<T>): T | undefined {
        return services.get(token.key) as T | undefined
      },
      requireService<T>(token: ServiceToken<T>): T {
        if (!services.has(token.key)) {
          throw new Error(
            `Module "${moduleId}" requires service "${token.key}", which no enabled module provides.`
          )
        }
        return services.get(token.key) as T
      },
      onStartup(hook) {
        startupHooks.push(hook)
      },
      onShutdown(hook) {
        shutdownHooks.push(hook)
      },
      registerSidecar(spec) {
        sidecars.push(spec)
      },
    }
  }

  return {
    hostFor,
    ownedChannels: () => channels,
    startupHooks: () => startupHooks,
    shutdownHooks: () => shutdownHooks,
    sidecars: () => sidecars,
  }
}
