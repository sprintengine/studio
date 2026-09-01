import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { type ModuleEventEnvelope } from '../../shared/modules/events';
import type { CapabilityManifest } from '../../shared/modules/manifest';
import type { McpToolRegistration } from '../../shared/modules/mcp-tools';
import { type ModuleNotification, type ModuleNotifyInput } from '../../shared/modules/notifications';
export type IpcInvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>;
export type StartupHook = () => void | Promise<void>;
export type ShutdownBeginHook = () => void | Promise<void>;
export type ShutdownHook = () => void | Promise<void>;
/**
 * Typed handle for a service one module provides and others require, without
 * direct imports across module boundaries. Create one per service contract.
 */
export type ServiceToken<T> = {
    readonly key: string;
    readonly __type?: T;
};
export declare function createServiceToken<T>(key: string): ServiceToken<T>;
export type SidecarSpec = {
    id: string;
    /** e.g. 'python', 'python-mcp', 'process'. Free-form; the SidecarHost interprets it. */
    kind: string;
    /** Python module name or executable, depending on kind. */
    module?: string;
    description?: string;
    /**
     * When the kernel spawns the sidecar: 'startup' (default) starts it during
     * `runStartup` in registration order; 'demand' leaves spawning to the owner
     * via the registration handle (for lazily-started daemons). Only meaningful
     * when a lifecycle is registered.
     */
    startOn?: 'startup' | 'demand';
};
export type SidecarRunState = 'declared' | 'stopped' | 'starting' | 'running' | 'failed';
export type SidecarLifecycle = {
    /** Spawn the process; resolve once running. Rejection is a spawn failure. */
    start(): Promise<void>;
    stop(): Promise<void>;
    /**
     * Truth source for demand-spawned processes whose starts can also be
     * triggered outside the kernel handle: when provided, status queries
     * reflect it instead of only kernel-observed transitions.
     */
    status?(): {
        state: SidecarRunState;
        error?: string;
    };
};
export type SidecarRuntimeStatus = {
    id: string;
    moduleId: string;
    kind: string;
    description?: string;
    state: SidecarRunState;
    error?: string;
};
export type McpToolContribution = {
    moduleId: string;
    /** The owner's manifest displayName when resolvable, for user-facing errors. */
    moduleDisplayName: string;
    registration: McpToolRegistration;
};
export type SidecarHandle = {
    start(): Promise<void>;
    stop(): Promise<void>;
    status(): SidecarRuntimeStatus;
};
export type MainHost = {
    /** The module currently registering. Useful for diagnostics and ownership. */
    readonly moduleId: string;
    /**
     * Raw ipcMain, for first-party (trusted, in-process) modules that reuse
     * existing `registerXIpc(ipcMain)` functions. Prefer `registerIpc` for new
     * code so channel ownership is tracked and collisions are caught.
     */
    readonly ipcMain: IpcMain;
    registerIpc(channel: string, handler: IpcInvokeHandler): void;
    /**
     * Contribute MCP tools to the always-on Studio gateway. Registrations are
     * owned by this module's id exactly as IPC channels are: a name another
     * module already holds is a registration error, and the whole batch is
     * validated before any tool lands so a rejected batch registers nothing.
     * Availability follows the owner's live enablement at the gateway — tools
     * of a disabled-but-registered module stay listed and answer an actionable
     * enable error instead of running (MC-1805/MC-1855).
     */
    registerMcpTools(tools: McpToolRegistration[]): void;
    provideService<T>(token: ServiceToken<T>, factory: (host: MainHost) => T): T;
    getService<T>(token: ServiceToken<T>): T | undefined;
    requireService<T>(token: ServiceToken<T>): T;
    onStartup(hook: StartupHook): void;
    /**
     * Run early, before the core shell tears down shared infrastructure
     * (automation, terminal runtime). Use it to stop self-scheduled loops and
     * flip a shutting-down flag so no new work is dispatched during teardown;
     * defer awaiting in-flight work to `onShutdown`. Begin hooks run in
     * registration order, opposite the reverse order of `onShutdown`.
     */
    onShutdownBegin(hook: ShutdownBeginHook): void;
    onShutdown(hook: ShutdownHook): void;
    /**
     * Declare a sidecar process this module owns. With a lifecycle, the kernel
     * owns spawn/stop: 'startup' sidecars spawn during runStartup (registration
     * order, composed with the module's other startup hooks) and every lifecycle
     * sidecar is stopped during runShutdown (reverse order). Spawn failures are
     * recorded as a queryable 'failed' status and surfaced as a module-identified
     * error notification. Without a lifecycle the registration stays declarative
     * (status 'declared').
     */
    registerSidecar(spec: SidecarSpec, lifecycle?: SidecarLifecycle): SidecarHandle;
    /**
     * Surface a user-visible status notification. The source module id is
     * stamped from this host's scope; invalid payloads throw. Emission is
     * flood-bounded per module (identical repeats and rate overruns are dropped).
     */
    notify(input: ModuleNotifyInput): void;
    /**
     * Push an event to this module's renderer half — the subscribe verb the
     * request/response bridge does not have. The source module id is stamped
     * from this host's scope, so only this module's `RendererHost.subscribe`
     * receives it; an empty or over-long topic throws. Fan-out reaches every open
     * window, ordering is FIFO per module, and nothing is replayed to a window
     * opened later: see the delivery contract in shared/modules/events.ts.
     * The payload crosses IPC and must be structured-cloneable.
     */
    emit(topic: string, payload?: unknown): void;
};
export type MainKernel = {
    /** A scoped host for the given module. Shares the kernel's registries. */
    hostFor(moduleId: string): MainHost;
    /** channel -> owning module id, for diagnostics and collision reports. */
    ownedChannels(): ReadonlyMap<string, string>;
    /** Module-contributed Studio gateway tools, in registration order. */
    mcpToolRegistrations(): ReadonlyArray<McpToolContribution>;
    startupHooks(): ReadonlyArray<StartupHook>;
    shutdownBeginHooks(): ReadonlyArray<ShutdownBeginHook>;
    shutdownHooks(): ReadonlyArray<ShutdownHook>;
    sidecars(): ReadonlyArray<SidecarSpec>;
    /** Live status per registered sidecar, in registration order. */
    sidecarStatuses(): ReadonlyArray<SidecarRuntimeStatus>;
    /** Run all registered startup hooks (in registration order), isolating failures. */
    runStartup(): Promise<void>;
    /** Run startup hooks owned by a live-loaded module after the app has started. */
    runStartupForModule(moduleId: string): Promise<void>;
    /** Run all registered shutdown-begin hooks (registration order), isolating failures. */
    runShutdownBegin(): Promise<void>;
    /** Run all registered shutdown hooks (reverse registration order), isolating failures. */
    runShutdown(): Promise<void>;
    /** Run a module's shutdown hooks and remove its tracked services, sidecars, and IPC. */
    unregisterModule(moduleId: string): Promise<void>;
    /** True once the app-level startup hook pipeline has run and before shutdown. */
    isStarted(): boolean;
    /**
     * Infrastructure-only notification entry: stamps `sourceModuleId`, applies
     * flood bounding, buffers, and delivers. Module code never sees the kernel —
     * it emits through its scoped host's `notify`, which delegates here with the
     * host's own id. The kernel is also how host-level diagnostics (e.g.
     * third-party entry.main launch failures) are attributed to the failing
     * module's identity.
     */
    emitNotification(sourceModuleId: string, input: ModuleNotifyInput): void;
    /** Recent notifications (bounded), newest last — replayed to late-opening windows. */
    recentNotifications(): ReadonlyArray<ModuleNotification>;
    /**
     * Infrastructure-only event entry, the twin of `emitNotification`: stamps
     * `sourceModuleId` and `emittedAt`, then delivers. Module code never sees the
     * kernel — it emits through its scoped host's `emit`. Nothing is buffered:
     * module events are signals, not diagnostics (see shared/modules/events.ts).
     */
    emitModuleEvent(sourceModuleId: string, topic: string, payload?: unknown): void;
};
export type MainKernelOptions = {
    /** Sends one notification to every open renderer window. Absent in tests. */
    deliverNotification?: (notification: ModuleNotification) => void;
    /** Sends one module event to every open renderer window. Absent in tests. */
    deliverModuleEvent?: (event: ModuleEventEnvelope) => void;
    /** Clock override for flood-bound tests. */
    now?: () => number;
    /**
     * Resolves a module id to its manifest, for the renderer→module-main bridge's
     * source/permission checks. The kernel has no manifest knowledge of its own;
     * load-modules passes its registry. Absent (or resolving to nothing) every
     * bridge invoke is refused as not bridgeable.
     */
    resolveModuleManifest?: (moduleId: string) => CapabilityManifest | undefined;
};
export declare function createMainKernel(ipcMain: IpcMain, options?: MainKernelOptions): MainKernel;
