import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  MODULE_NOTIFICATIONS_EVENT_CHANNEL,
  validateModuleNotifyInput,
  type ModuleNotification,
  type ModuleNotifyInput,
} from '../../shared/modules/notifications'

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
  /**
   * When the kernel spawns the sidecar: 'startup' (default) starts it during
   * `runStartup` in registration order; 'demand' leaves spawning to the owner
   * via the registration handle (for lazily-started daemons). Only meaningful
   * when a lifecycle is registered.
   */
  startOn?: 'startup' | 'demand'
}

export type SidecarRunState = 'declared' | 'stopped' | 'starting' | 'running' | 'failed'

// Process control a module hands the kernel along with its sidecar spec. The
// kernel owns *when* start/stop run and the resulting status; the lifecycle
// owns *how* (the module keeps its existing process management).
export type SidecarLifecycle = {
  /** Spawn the process; resolve once running. Rejection is a spawn failure. */
  start(): Promise<void>
  stop(): Promise<void>
  /**
   * Truth source for demand-spawned processes whose starts can also be
   * triggered outside the kernel handle: when provided, status queries
   * reflect it instead of only kernel-observed transitions.
   */
  status?(): { state: SidecarRunState; error?: string }
}

export type SidecarRuntimeStatus = {
  id: string
  moduleId: string
  kind: string
  description?: string
  state: SidecarRunState
  error?: string
}

// Returned by registerSidecar so an owner can trigger a demand-spawned sidecar
// through the kernel-tracked path (status + failure notification included).
export type SidecarHandle = {
  start(): Promise<void>
  stop(): Promise<void>
  status(): SidecarRuntimeStatus
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
  /**
   * Declare a sidecar process this module owns. With a lifecycle, the kernel
   * owns spawn/stop: 'startup' sidecars spawn during runStartup (registration
   * order, composed with the module's other startup hooks) and every lifecycle
   * sidecar is stopped during runShutdown (reverse order). Spawn failures are
   * recorded as a queryable 'failed' status and surfaced as a module-identified
   * error notification. Without a lifecycle the registration stays declarative
   * (status 'declared').
   */
  registerSidecar(spec: SidecarSpec, lifecycle?: SidecarLifecycle): SidecarHandle
  /**
   * Surface a user-visible status notification. The source module id is
   * stamped from this host's scope; invalid payloads throw. Emission is
   * flood-bounded per module (identical repeats and rate overruns are dropped).
   */
  notify(input: ModuleNotifyInput): void
}

export type MainKernel = {
  /** A scoped host for the given module. Shares the kernel's registries. */
  hostFor(moduleId: string): MainHost
  /** channel -> owning module id, for diagnostics and collision reports. */
  ownedChannels(): ReadonlyMap<string, string>
  startupHooks(): ReadonlyArray<StartupHook>
  shutdownHooks(): ReadonlyArray<ShutdownHook>
  sidecars(): ReadonlyArray<SidecarSpec>
  /** Live status per registered sidecar, in registration order. */
  sidecarStatuses(): ReadonlyArray<SidecarRuntimeStatus>
  /** Run all registered startup hooks (in registration order), isolating failures. */
  runStartup(): Promise<void>
  /** Run startup hooks owned by a live-loaded module after the app has started. */
  runStartupForModule(moduleId: string): Promise<void>
  /** Run all registered shutdown hooks (reverse registration order), isolating failures. */
  runShutdown(): Promise<void>
  /** Run a module's shutdown hooks and remove its tracked services, sidecars, and IPC. */
  unregisterModule(moduleId: string): Promise<void>
  /** True once the app-level startup hook pipeline has run and before shutdown. */
  isStarted(): boolean
  /**
   * Infrastructure-only notification entry: stamps `sourceModuleId`, applies
   * flood bounding, buffers, and delivers. Module code never sees the kernel —
   * it emits through its scoped host's `notify`, which delegates here with the
   * host's own id. The kernel is also how host-level diagnostics (e.g.
   * third-party entry.main launch failures) are attributed to the failing
   * module's identity.
   */
  emitNotification(sourceModuleId: string, input: ModuleNotifyInput): void
  /** Recent notifications (bounded), newest last — replayed to late-opening windows. */
  recentNotifications(): ReadonlyArray<ModuleNotification>
}

export type MainKernelOptions = {
  /** Sends one notification to every open renderer window. Absent in tests. */
  deliverNotification?: (notification: ModuleNotification) => void
  /** Clock override for flood-bound tests. */
  now?: () => number
}

// Flood bounds: a module may emit at most this many notifications per window;
// an emission identical to the module's previous one inside the window is
// dropped as a repeat. Both protect the channel from a misbehaving module.
const NOTIFICATION_RATE_WINDOW_MS = 10_000
const NOTIFICATION_RATE_MAX_PER_WINDOW = 20
const NOTIFICATION_BUFFER_LIMIT = 50

type ModuleNotificationFloodState = {
  emittedAt: number[]
  lastKey: string
  lastAt: number
  warnedDropAt: number
}

type SidecarEntry = {
  spec: SidecarSpec
  moduleId: string
  lifecycle?: SidecarLifecycle
  /** Kernel-observed state; lifecycle.status() overrides it when provided. */
  state: SidecarRunState
  error?: string
  /** In-flight start, so concurrent start() calls share one spawn. */
  pendingStart?: Promise<void>
}

type HookEntry<T> = {
  moduleId: string
  hook: T
}

type ServiceEntry = {
  moduleId: string
  value: unknown
}

export function createMainKernel(ipcMain: IpcMain, options: MainKernelOptions = {}): MainKernel {
  const channels = new Map<string, string>()
  const services = new Map<string, ServiceEntry>()
  let startupHooks: HookEntry<StartupHook>[] = []
  let shutdownHooks: HookEntry<ShutdownHook>[] = []
  const sidecarEntries = new Map<string, SidecarEntry>()
  const now = options.now ?? Date.now
  const recent: ModuleNotification[] = []
  const floodStateByModule = new Map<string, ModuleNotificationFloodState>()
  let started = false

  // The notifications event channel belongs to the host kernel; reserving it
  // here makes a module's attempt to claim the name a registration error.
  channels.set(MODULE_NOTIFICATIONS_EVENT_CHANNEL, '@host')

  function emitNotification(sourceModuleId: string, input: ModuleNotifyInput): void {
    const validated = validateModuleNotifyInput(input)
    if (!validated.ok) {
      throw new Error(`Module "${sourceModuleId}" ${validated.message}`)
    }
    const emittedAt = now()
    if (!passesFloodBound(sourceModuleId, validated.severity, validated.title, validated.body, emittedAt)) return
    const notification: ModuleNotification = {
      sourceModuleId,
      severity: validated.severity,
      title: validated.title,
      body: validated.body,
      emittedAt,
    }
    recent.push(notification)
    if (recent.length > NOTIFICATION_BUFFER_LIMIT) recent.splice(0, recent.length - NOTIFICATION_BUFFER_LIMIT)
    options.deliverNotification?.(notification)
  }

  function passesFloodBound(
    moduleId: string,
    severity: string,
    title: string,
    body: string | undefined,
    emittedAt: number
  ): boolean {
    const state = floodStateByModule.get(moduleId) ?? { emittedAt: [], lastKey: '', lastAt: 0, warnedDropAt: 0 }
    floodStateByModule.set(moduleId, state)
    const windowStart = emittedAt - NOTIFICATION_RATE_WINDOW_MS
    state.emittedAt = state.emittedAt.filter((at) => at > windowStart)

    const key = JSON.stringify([severity, title, body ?? ''])
    const isRepeat = key === state.lastKey && state.lastAt > windowStart
    const isOverRate = state.emittedAt.length >= NOTIFICATION_RATE_MAX_PER_WINDOW
    if (isRepeat || isOverRate) {
      if (state.warnedDropAt <= windowStart) {
        state.warnedDropAt = emittedAt
        console.warn(
          `[modules] dropping notifications from "${moduleId}" (${isOverRate ? 'rate cap reached' : 'identical repeat'}).`
        )
      }
      return false
    }

    state.emittedAt.push(emittedAt)
    state.lastKey = key
    state.lastAt = emittedAt
    return true
  }

  async function startSidecar(entry: SidecarEntry): Promise<void> {
    const lifecycle = entry.lifecycle
    if (!lifecycle) {
      throw new Error(`Sidecar "${entry.spec.id}" was registered without a lifecycle and cannot be started.`)
    }
    if (entry.state === 'running') return
    if (entry.pendingStart) return entry.pendingStart
    entry.state = 'starting'
    entry.error = undefined
    entry.pendingStart = (async () => {
      try {
        await lifecycle.start()
        entry.state = 'running'
      } catch (err) {
        entry.state = 'failed'
        entry.error = err instanceof Error ? err.message : String(err)
        emitNotification(entry.moduleId, {
          severity: 'error',
          title: `Sidecar "${entry.spec.id}" failed to start`,
          body: entry.error,
        })
        throw err
      } finally {
        entry.pendingStart = undefined
      }
    })()
    return entry.pendingStart
  }

  async function stopSidecar(entry: SidecarEntry): Promise<void> {
    if (!entry.lifecycle) return
    if (entry.pendingStart) {
      try {
        await entry.pendingStart
      } catch {
        if (sidecarState(entry) !== 'running') return
      }
    }
    const current = sidecarState(entry)
    if (current !== 'starting' && current !== 'running') return
    try {
      await entry.lifecycle.stop()
      entry.state = 'stopped'
      entry.error = undefined
    } catch (err) {
      entry.state = 'failed'
      entry.error = err instanceof Error ? err.message : String(err)
      throw err
    }
  }

  function sidecarState(entry: SidecarEntry): SidecarRunState {
    return entry.lifecycle?.status?.().state ?? entry.state
  }

  function sidecarStatusOf(entry: SidecarEntry): SidecarRuntimeStatus {
    const delegated = entry.lifecycle?.status?.()
    return {
      id: entry.spec.id,
      moduleId: entry.moduleId,
      kind: entry.spec.kind,
      description: entry.spec.description,
      state: delegated?.state ?? entry.state,
      error: delegated ? delegated.error : entry.error,
    }
  }

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
        services.set(token.key, { moduleId, value: instance })
        return instance
      },
      getService<T>(token: ServiceToken<T>): T | undefined {
        return services.get(token.key)?.value as T | undefined
      },
      requireService<T>(token: ServiceToken<T>): T {
        if (!services.has(token.key)) {
          throw new Error(
            `Module "${moduleId}" requires service "${token.key}", which no enabled module provides.`
          )
        }
        return services.get(token.key)!.value as T
      },
      onStartup(hook) {
        startupHooks.push({ moduleId, hook })
      },
      onShutdown(hook) {
        shutdownHooks.push({ moduleId, hook })
      },
      registerSidecar(spec, lifecycle) {
        const existing = sidecarEntries.get(spec.id)
        if (existing) {
          throw new Error(`Sidecar "${spec.id}" is already registered by module "${existing.moduleId}".`)
        }
        const entry: SidecarEntry = {
          spec,
          moduleId,
          lifecycle,
          state: lifecycle ? 'stopped' : 'declared',
        }
        sidecarEntries.set(spec.id, entry)
        if (lifecycle) {
          // Compose with the hook pipeline: spawn keeps registration order
          // among this module's other startup hooks, and runShutdown's reverse
          // order stops sidecars last-started-first.
          if (spec.startOn !== 'demand') {
            startupHooks.push({ moduleId, hook: () => startSidecar(entry) })
          }
          shutdownHooks.push({ moduleId, hook: () => stopSidecar(entry) })
        }
        return {
          start: () => startSidecar(entry),
          stop: () => stopSidecar(entry),
          status: () => sidecarStatusOf(entry),
        }
      },
      notify(input) {
        emitNotification(moduleId, input)
      },
    }
  }

  async function runHooks(hooks: ReadonlyArray<HookEntry<StartupHook | ShutdownHook>>, failureLabel: string): Promise<void> {
    for (const { hook } of hooks) {
      try {
        await hook()
      } catch (err) {
        console.warn(`[modules] ${failureLabel} hook failed:`, err)
      }
    }
  }

  async function unregisterModule(moduleId: string): Promise<void> {
    await runHooks(
      [...shutdownHooks].reverse().filter((entry) => entry.moduleId === moduleId),
      `shutdown for module "${moduleId}"`
    )

    startupHooks = startupHooks.filter((entry) => entry.moduleId !== moduleId)
    shutdownHooks = shutdownHooks.filter((entry) => entry.moduleId !== moduleId)

    for (const [sidecarId, entry] of [...sidecarEntries]) {
      if (entry.moduleId === moduleId) sidecarEntries.delete(sidecarId)
    }
    for (const [channel, owner] of [...channels]) {
      if (owner !== moduleId) continue
      channels.delete(channel)
      ipcMain.removeHandler(channel)
    }
    for (const [serviceKey, entry] of [...services]) {
      if (entry.moduleId === moduleId) services.delete(serviceKey)
    }
  }

  return {
    hostFor,
    ownedChannels: () => channels,
    startupHooks: () => startupHooks.map((entry) => entry.hook),
    shutdownHooks: () => shutdownHooks.map((entry) => entry.hook),
    sidecars: () => [...sidecarEntries.values()].map((entry) => entry.spec),
    sidecarStatuses: () => [...sidecarEntries.values()].map(sidecarStatusOf),
    emitNotification,
    recentNotifications: () => recent,
    async runStartup(): Promise<void> {
      started = true
      await runHooks(startupHooks, 'startup')
    },
    async runStartupForModule(moduleId: string): Promise<void> {
      await runHooks(
        startupHooks.filter((entry) => entry.moduleId === moduleId),
        `startup for module "${moduleId}"`
      )
    },
    async runShutdown(): Promise<void> {
      await runHooks([...shutdownHooks].reverse(), 'shutdown')
      started = false
    },
    unregisterModule,
    isStarted: () => started,
  }
}
