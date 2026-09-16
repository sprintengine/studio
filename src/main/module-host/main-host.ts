import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  MODULE_BRIDGE_INVOKE_CHANNEL,
  type ModuleBridgeInvokeResult,
} from '../../shared/modules/bridge'
import {
  MODULE_EVENTS_CHANNEL,
  validateModuleEventTopic,
  type ModuleEventEnvelope,
} from '../../shared/modules/events'
import type { CapabilityManifest } from '../../shared/modules/manifest'
import type { McpToolRegistration } from '../../shared/modules/mcp-tools'
import {
  validateModuleNotifyInput,
  type ModuleNotification,
  type ModuleNotifyInput,
} from '../../shared/modules/notifications'
import type { LaunchContribution } from '../../shared/modules/launch-contributions'
import type { EnsureSkillInstalledResult, ModuleSkillRegistration } from '../../shared/modules/skills'
import {
  addLaunchContribution,
  removeLaunchContributionsForModule,
  setLaunchContributionFailureReporter,
} from './launch-contributions'
import {
  ensureSkillInstalled as ensureSkillInstalledOnDisk,
  registerModuleSkills,
  unregisterModuleSkills,
} from '../builtin-skills'
import { resolveModuleSkillDirectory } from '../modules/entry-containment'

// Main-process host kernel. Replaces the static, central wiring in
// app-services.ts / register-*-ipc.ts with registries that capability modules
// register themselves into. Each module receives a scoped `MainHost` that
// carries its own id but shares the kernel's registries, so cross-module
// services and IPC ownership are tracked centrally.

export type IpcInvokeHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown | Promise<unknown>

type StartupHook = () => void | Promise<void>
type ShutdownBeginHook = () => void | Promise<void>
type ShutdownHook = () => void | Promise<void>

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
  /** e.g. 'process'. Free-form; the owner's lifecycle interprets it. */
  kind: string
  /** Entry point or executable, depending on kind. */
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

export type SidecarStartOptions = {
  /** Merged into the child env for this start only (e.g. a per-start token). */
  env?: Record<string, string>
}

/**
 * Handle returned by `registerSidecar`. `start`/`stop` drive the registered
 * lifecycle; a sidecar registered without one is a declaration, and `start`
 * refuses it.
 */
export type SidecarHandle = {
  start(options?: SidecarStartOptions): Promise<void>
  stop(): Promise<void>
  status(): SidecarRuntimeStatus
}

// Process control a module hands the kernel along with its sidecar spec. The
// kernel owns *when* start/stop run and the resulting status; the lifecycle
// owns *how* (the module keeps its existing process management).
export type SidecarLifecycle = {
  /** Spawn the process; resolve once running. Rejection is a spawn failure. */
  start(options?: SidecarStartOptions): Promise<void>
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

// One MCP tool a module contributed to the Studio gateway, with the ownership
// the gateway needs to gate calls on the owner's live enablement (MC-1855).
export type McpToolContribution = {
  moduleId: string
  /** The owner's manifest displayName when resolvable, for user-facing errors. */
  moduleDisplayName: string
  registration: McpToolRegistration
}

/**
 * The process-wide skill registry the kernel writes module skills into. The
 * real one lives in src/main/builtin-skills.ts beside the skills the app
 * bundles, so a module skill and a built-in skill resolve through one lookup
 * at the launch boundary. Injectable so the kernel's own tests can watch the
 * host surface without touching the filesystem.
 */
export type ModuleSkillHostRegistry = {
  /** `sourceDir` on each registration is already absolute and root-checked. */
  register(moduleId: string, registrations: readonly ModuleSkillRegistration[]): void
  unregister(moduleId: string): void
  ensureInstalled(workspaceRoot: string, skillId: string): Promise<EnsureSkillInstalledResult>
}

const defaultSkillRegistry: ModuleSkillHostRegistry = {
  register: registerModuleSkills,
  unregister: unregisterModuleSkills,
  ensureInstalled: ensureSkillInstalledOnDisk,
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
  /**
   * Contribute MCP tools to the always-on Studio gateway. Registrations are
   * owned by this module's id exactly as IPC channels are: a name another
   * module already holds is a registration error, and the whole batch is
   * validated before any tool lands so a rejected batch registers nothing.
   * Availability follows the owner's live enablement at the gateway — tools
   * of a disabled-but-registered module stay listed and answer an actionable
   * enable error instead of running (MC-1805/MC-1855).
   */
  registerMcpTools(tools: McpToolRegistration[]): void
  /**
   * Contribute agent skills this module ships. Each `sourceDir` is relative to
   * the module root and must stay inside it; a module with no root on disk
   * passes an absolute path. Registrations are owned exactly as IPC channels
   * and MCP tools are: an id a built-in skill or another module already holds
   * is a registration error, the whole batch is validated before any of it
   * lands, and unloading the module takes its skills with it.
   *
   * A registered skill is a skill: the launch boundary's `spawnSkillId`
   * resolves it, and `targetPolicy: 'all-native'` fans it out into every
   * installed CLI's native skill directory the way a built-in does.
   */
  registerSkills(skills: ModuleSkillRegistration[]): void
  /**
   * Make a skill present in a workspace now, rather than at the next spawn —
   * how a module pre-installs the skill an agent will be told to invoke. Works
   * for this module's own skills and for the app's. Never throws; an unknown
   * id answers `{ ok: false, status: 'unknown-skill' }`.
   */
  ensureSkillInstalled(workspaceRoot: string, skillId: string): Promise<EnsureSkillInstalledResult>
  provideService<T>(token: ServiceToken<T>, factory: (host: MainHost) => T): T
  getService<T>(token: ServiceToken<T>): T | undefined
  requireService<T>(token: ServiceToken<T>): T
  onStartup(hook: StartupHook): void
  /**
   * Run early, before the core shell tears down shared infrastructure
   * (automation, terminal runtime). Use it to stop self-scheduled loops and
   * flip a shutting-down flag so no new work is dispatched during teardown;
   * defer awaiting in-flight work to `onShutdown`. Begin hooks run in
   * registration order, opposite the reverse order of `onShutdown`.
   */
  onShutdownBegin(hook: ShutdownBeginHook): void
  onShutdown(hook: ShutdownHook): void
  /**
   * Declare a sidecar process this module owns. With a module-supplied
   * lifecycle, the kernel owns when spawn/stop run: 'startup' sidecars spawn
   * during runStartup and every lifecycle sidecar is stopped during runShutdown.
   * Spawn failures are recorded as a queryable 'failed' status and surfaced as
   * a module-identified error notification. Without a lifecycle the
   * registration stays declarative (status 'declared').
   */
  registerSidecar(spec: SidecarSpec, lifecycle?: SidecarLifecycle): SidecarHandle
  /**
   * Contribute env, PATH shims, shell functions, managed-MCP server entries,
   * host-context sections and a session lifetime tag to every agent launch.
   * Called per spawn in module registration order; a throw is recorded as a
   * module diagnostic and skipped — it never fails the launch. A disabled or
   * absent module contributes nothing. Declare `ipc:agents`.
   */
  registerLaunchContribution(contribution: LaunchContribution): void
  /**
   * Surface a user-visible status notification. The source module id is
   * stamped from this host's scope; invalid payloads throw. Emission is
   * flood-bounded per module (identical repeats and rate overruns are dropped).
   */
  notify(input: ModuleNotifyInput): void
  /**
   * Push an event to this module's renderer half — the subscribe verb the
   * request/response bridge does not have. The source module id is stamped
   * from this host's scope, so only this module's `RendererHost.subscribe`
   * receives it; an empty or over-long topic throws. Fan-out reaches every open
   * window, ordering is FIFO per module, and nothing is replayed to a window
   * opened later: see the delivery contract in shared/modules/events.ts.
   * The payload crosses IPC and must be structured-cloneable.
   */
  emit(topic: string, payload?: unknown): void
}

export type MainKernel = {
  /** A scoped host for the given module. Shares the kernel's registries. */
  hostFor(moduleId: string): MainHost
  /** channel -> owning module id, for diagnostics and collision reports. */
  ownedChannels(): ReadonlyMap<string, string>
  /** skill id -> owning module id, for diagnostics and collision reports. */
  ownedSkills(): ReadonlyMap<string, string>
  /** Module-contributed Studio gateway tools, in registration order. */
  mcpToolRegistrations(): ReadonlyArray<McpToolContribution>
  startupHooks(): ReadonlyArray<StartupHook>
  shutdownBeginHooks(): ReadonlyArray<ShutdownBeginHook>
  shutdownHooks(): ReadonlyArray<ShutdownHook>
  sidecars(): ReadonlyArray<SidecarSpec>
  /** Live status per registered sidecar, in registration order. */
  sidecarStatuses(): ReadonlyArray<SidecarRuntimeStatus>
  /** Run all registered startup hooks (in registration order), isolating failures. */
  runStartup(): Promise<void>
  /** Run startup hooks owned by a live-loaded module after the app has started. */
  runStartupForModule(moduleId: string): Promise<void>
  /** Run all registered shutdown-begin hooks (registration order), isolating failures. */
  runShutdownBegin(): Promise<void>
  /** Run all registered shutdown hooks (reverse registration order), isolating failures. */
  runShutdown(): Promise<void>
  /** Run a module's shutdown hooks and remove its tracked services, sidecars, and IPC. */
  unregisterModule(moduleId: string): Promise<void>
  /** True once the app-level startup hook pipeline has run and before shutdown. */
  isStarted(): boolean
  /**
   * Infrastructure-only notification entry: stamps `sourceModuleId`, applies
   * flood bounding, and buffers. Module code never sees the kernel —
   * it emits through its scoped host's `notify`, which delegates here with the
   * host's own id. The kernel is also how host-level diagnostics (e.g.
   * third-party entry.main launch failures) are attributed to the failing
   * module's identity.
   */
  emitNotification(sourceModuleId: string, input: ModuleNotifyInput): void
  /** Recent notifications (bounded), newest last. The kernel's diagnostics record. */
  recentNotifications(): ReadonlyArray<ModuleNotification>
  /**
   * Infrastructure-only event entry, the twin of `emitNotification`: stamps
   * `sourceModuleId` and `emittedAt`, then delivers. Module code never sees the
   * kernel — it emits through its scoped host's `emit`. Nothing is buffered:
   * module events are signals, not diagnostics (see shared/modules/events.ts).
   */
  emitModuleEvent(sourceModuleId: string, topic: string, payload?: unknown): void
}

export type MainKernelOptions = {
  /** Sends one module event to every open renderer window. Absent in tests. */
  deliverModuleEvent?: (event: ModuleEventEnvelope) => void
  /** Clock override for flood-bound tests. */
  now?: () => number
  /**
   * Resolves a module id to its manifest, for the renderer→module-main bridge's
   * source/permission checks. The kernel has no manifest knowledge of its own;
   * load-modules passes its registry. Absent (or resolving to nothing) every
   * bridge invoke is refused as not bridgeable.
   */
  resolveModuleManifest?: (moduleId: string) => CapabilityManifest | undefined
  /**
   * Resolves a module id to its root directory on disk, for containment-
   * checking the skill directories it registers. Third-party modules have one
   * (the install folder); bundled modules do not, and pass absolute paths.
   */
  resolveModuleRoot?: (moduleId: string) => string | undefined
  /** Skill registry override. Defaults to the real one in builtin-skills.ts. */
  skillRegistry?: ModuleSkillHostRegistry
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
  startEnv?: Record<string, string>
}

type HookEntry<T> = {
  moduleId: string
  hook: T
}

type ServiceEntry = {
  moduleId: string
  value: unknown
}

// One record per registered channel: ownership for collision reports and
// teardown, plus the handler itself — ipcMain cannot be invoked in-process,
// and the bridge dispatcher needs to call owned handlers directly. Reserved
// event channels (owner '@host', no invoke handler) have no `handler`.
type ChannelEntry = { owner: string; handler?: IpcInvokeHandler }

export function createMainKernel(ipcMain: IpcMain, options: MainKernelOptions = {}): MainKernel {
  const channels = new Map<string, ChannelEntry>()
  // name -> owning module + registration; insertion order is the gateway's
  // listing order, mirroring the channel map's ownership discipline.
  const mcpTools = new Map<string, { owner: string; registration: McpToolRegistration }>()
  const services = new Map<string, ServiceEntry>()
  let startupHooks: HookEntry<StartupHook>[] = []
  let shutdownBeginHooks: HookEntry<ShutdownBeginHook>[] = []
  let shutdownHooks: HookEntry<ShutdownHook>[] = []
  const sidecarEntries = new Map<string, SidecarEntry>()
  // Skill ids per module, so unregisterModule can drop them without asking the
  // registry to scan. The registry is the truth; this is the kernel's receipt.
  const skillIdsByModule = new Map<string, Set<string>>()
  const skillRegistry = options.skillRegistry ?? defaultSkillRegistry
  const now = options.now ?? Date.now
  const recent: ModuleNotification[] = []
  const floodStateByModule = new Map<string, ModuleNotificationFloodState>()
  let started = false

  // The module-events channel belongs to the host kernel; reserving it here
  // makes a module's attempt to claim it a registration error.
  channels.set(MODULE_EVENTS_CHANNEL, { owner: '@host' })

  // The renderer→module-main bridge dispatcher. Routes an invoke to a channel
  // a module registered via registerIpc, applying the bridgeability rules
  // (owner prefix + `ipc:invoke` permission); every refusal is structured
  // data (see bridge.ts). This is defense in depth for a contract, not a
  // security boundary — the renderer-side host already validates the
  // module-id prefix before IPC.
  // Registered through the kernel's own registerIpc so the dispatcher channel
  // shares every other channel's ownership tracking and lifecycle.
  async function dispatchBridgeInvoke(
    event: IpcMainInvokeEvent,
    request: unknown
  ): Promise<ModuleBridgeInvokeResult> {
    const channel =
      typeof (request as { channel?: unknown } | undefined)?.channel === 'string'
        ? (request as { channel: string }).channel
        : ''
    const payload = (request as { payload?: unknown } | undefined)?.payload
    const entry = channels.get(channel)
    if (!entry?.handler) {
      return {
        ok: false,
        code: 'unknown_channel',
        message: `No module has registered the IPC channel "${channel}".`,
      }
    }
    if (!channel.startsWith(`${entry.owner}:`)) {
      return {
        ok: false,
        code: 'not_bridgeable',
        message: `Channel "${channel}" is not bridgeable: bridged channels must be prefixed with their owning module's id ("${entry.owner}:").`,
      }
    }
    const manifest = options.resolveModuleManifest?.(entry.owner)
    if (!manifest) {
      return {
        ok: false,
        code: 'not_bridgeable',
        message: `Channel "${channel}" is not bridgeable: the owning module's manifest could not be resolved.`,
      }
    }
    if (!manifest.permissions?.includes('ipc:invoke')) {
      return {
        ok: false,
        code: 'permission_missing',
        message: `Module "${entry.owner}" does not declare the "ipc:invoke" permission, so its channels cannot be bridged.`,
      }
    }
    return { ok: true, result: await entry.handler(event, payload) }
  }
  hostFor('@host').registerIpc(MODULE_BRIDGE_INVOKE_CHANNEL, dispatchBridgeInvoke)

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
  }

  setLaunchContributionFailureReporter((failure) => {
    try {
      emitNotification(failure.moduleId, {
        severity: 'warning',
        title: 'Launch contribution failed',
        body: failure.message,
      })
    } catch (error) {
      console.warn(
        `[modules] launch contribution from "${failure.moduleId}" failed: ${failure.message}`,
        error
      )
    }
  })

  function emitModuleEvent(sourceModuleId: string, topic: string, payload?: unknown): void {
    const validated = validateModuleEventTopic(topic)
    if (!validated.ok) {
      throw new Error(`Module "${sourceModuleId}" ${validated.message}`)
    }
    // Deliberately unbuffered and unbounded: a dropped event makes a
    // subscriber wrong, where a dropped notification only costs a message.
    options.deliverModuleEvent?.({
      sourceModuleId,
      topic: validated.topic,
      ...(payload === undefined ? {} : { payload }),
      emittedAt: now(),
    })
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

  function sidecarHandleOf(entry: SidecarEntry): SidecarHandle {
    return {
      start: (startOptions) => startSidecar(entry, startOptions),
      stop: () => stopSidecar(entry),
      status: () => sidecarStatusOf(entry),
    }
  }

  async function startSidecar(entry: SidecarEntry, startOptions?: SidecarStartOptions): Promise<void> {
    const lifecycle = entry.lifecycle
    if (!lifecycle) {
      throw new Error(`Sidecar "${entry.spec.id}" was registered without a lifecycle and cannot be started.`)
    }
    if (startOptions?.env) entry.startEnv = startOptions.env
    if (entry.state === 'running') return
    if (entry.pendingStart) return entry.pendingStart
    entry.state = 'starting'
    entry.error = undefined
    entry.pendingStart = (async () => {
      try {
        await lifecycle.start(startOptions ?? (entry.startEnv ? { env: entry.startEnv } : undefined))
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
        entry.startEnv = undefined
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
        const existing = channels.get(channel)
        if (existing) {
          throw new Error(
            `IPC channel "${channel}" is already registered by module "${existing.owner}".`
          )
        }
        channels.set(channel, { owner: moduleId, handler })
        ipcMain.handle(channel, handler)
      },
      registerMcpTools(tools) {
        // Validate the whole batch before landing any of it: a module whose
        // registerMain fails on a collision must not leave half its tools
        // behind on the always-serving gateway.
        const batch = new Set<string>()
        for (const tool of tools) {
          const existing = mcpTools.get(tool.name)
          if (existing) {
            throw new Error(
              `MCP tool "${tool.name}" is already registered by module "${existing.owner}".`
            )
          }
          if (batch.has(tool.name)) {
            throw new Error(`MCP tool "${tool.name}" is registered twice by module "${moduleId}".`)
          }
          batch.add(tool.name)
        }
        for (const tool of tools) {
          mcpTools.set(tool.name, { owner: moduleId, registration: tool })
        }
      },
      registerSkills(skills) {
        // Resolve every path before any of it lands: a batch that escapes the
        // module root on its third skill must not leave the first two behind,
        // exactly as with MCP tool names.
        const resolved = skills.map((skill) => ({
          ...skill,
          sourceDir: resolveModuleSkillDirectory(
            options.resolveModuleRoot?.(moduleId) ?? null,
            skill.sourceDir,
            `Module "${moduleId}" skill "${skill.id}" sourceDir`
          ),
        }))
        skillRegistry.register(moduleId, resolved)
        const owned = skillIdsByModule.get(moduleId) ?? new Set<string>()
        for (const skill of resolved) owned.add(skill.id)
        skillIdsByModule.set(moduleId, owned)
      },
      ensureSkillInstalled(workspaceRoot, skillId) {
        return skillRegistry.ensureInstalled(workspaceRoot, skillId)
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
      onShutdownBegin(hook) {
        shutdownBeginHooks.push({ moduleId, hook })
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
        if (entry.lifecycle) {
          // Compose with the hook pipeline: spawn keeps registration order
          // among this module's other startup hooks, and runShutdown's reverse
          // order stops sidecars last-started-first.
          if (spec.startOn !== 'demand') {
            startupHooks.push({ moduleId, hook: () => startSidecar(entry) })
          }
          shutdownHooks.push({ moduleId, hook: () => stopSidecar(entry) })
        }
        return sidecarHandleOf(entry)
      },
      registerLaunchContribution(contribution) {
        addLaunchContribution(moduleId, contribution)
      },
      notify(input) {
        emitNotification(moduleId, input)
      },
      emit(topic, payload) {
        emitModuleEvent(moduleId, topic, payload)
      },
    }
  }

  async function runHooks(hooks: ReadonlyArray<HookEntry<StartupHook | ShutdownBeginHook | ShutdownHook>>, failureLabel: string): Promise<void> {
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
      shutdownBeginHooks.filter((entry) => entry.moduleId === moduleId),
      `shutdown-begin for module "${moduleId}"`
    )
    await runHooks(
      [...shutdownHooks].reverse().filter((entry) => entry.moduleId === moduleId),
      `shutdown for module "${moduleId}"`
    )

    startupHooks = startupHooks.filter((entry) => entry.moduleId !== moduleId)
    shutdownBeginHooks = shutdownBeginHooks.filter((entry) => entry.moduleId !== moduleId)
    shutdownHooks = shutdownHooks.filter((entry) => entry.moduleId !== moduleId)

    for (const [sidecarId, entry] of [...sidecarEntries]) {
      if (entry.moduleId === moduleId) sidecarEntries.delete(sidecarId)
    }
    for (const [channel, entry] of [...channels]) {
      if (entry.owner !== moduleId) continue
      channels.delete(channel)
      ipcMain.removeHandler(channel)
    }
    for (const [toolName, entry] of [...mcpTools]) {
      if (entry.owner === moduleId) mcpTools.delete(toolName)
    }
    for (const [serviceKey, entry] of [...services]) {
      if (entry.moduleId === moduleId) services.delete(serviceKey)
    }
    if (skillIdsByModule.delete(moduleId)) skillRegistry.unregister(moduleId)
    removeLaunchContributionsForModule(moduleId)
  }

  return {
    hostFor,
    ownedChannels: () => new Map([...channels].map(([channel, entry]) => [channel, entry.owner])),
    ownedSkills: () =>
      new Map([...skillIdsByModule].flatMap(([owner, ids]) => [...ids].map((id) => [id, owner] as const))),
    mcpToolRegistrations: () =>
      [...mcpTools.values()].map(({ owner, registration }) => ({
        moduleId: owner,
        moduleDisplayName: options.resolveModuleManifest?.(owner)?.displayName ?? owner,
        registration,
      })),
    startupHooks: () => startupHooks.map((entry) => entry.hook),
    shutdownBeginHooks: () => shutdownBeginHooks.map((entry) => entry.hook),
    shutdownHooks: () => shutdownHooks.map((entry) => entry.hook),
    sidecars: () => [...sidecarEntries.values()].map((entry) => entry.spec),
    sidecarStatuses: () => [...sidecarEntries.values()].map(sidecarStatusOf),
    emitNotification,
    recentNotifications: () => recent,
    emitModuleEvent,
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
    async runShutdownBegin(): Promise<void> {
      await runHooks(shutdownBeginHooks, 'shutdown-begin')
    },
    async runShutdown(): Promise<void> {
      await runHooks([...shutdownHooks].reverse(), 'shutdown')
      started = false
    },
    unregisterModule,
    isStarted: () => started,
  }
}
