import type { CapabilityManifest, ModuleEnablementOverrides } from '../../../shared/modules/manifest'
import type { MarketplacePluginRegistryInstallResult } from '../../../shared/electron-api'
import { activeForChannel } from '../../../shared/modules/dev-only'
import { resolveModuleEnablement } from '../../../shared/modules/resolve'
import { toModuleWorkspaceView, type ModuleWorkspaceView } from '../../../shared/modules/workspace-view'
import { markStartup } from '../utils/startupTimeline'
import { agentRuntimeRendererModule } from './agent-runtime-module'
import { automationsRendererModule } from './automations-module'
import { backlogRendererModule } from './backlog-module'
import { designRendererModule } from './design-module'
import { devToolsRendererModule } from './dev-tools-module'
import { gitRendererModule } from './git-module'
import { memoryRendererModule } from './memory-module'
import { mobileRelayRendererModule } from './mobile-relay-module'
import { sprintEngineRendererModule } from './sprint-engine-module'
import { voiceDictationRendererModule } from './voice-dictation-module'
import { createRendererHost, type RendererModule } from './renderer-host'

// Bundled renderer capability modules. Features migrate onto the host one at a
// time; this list grows as each renderer surface is extracted from the
// hardcoded factory switch / panel rail.
const BUNDLED_RENDERER_MODULES: RendererModule[] = [
  agentRuntimeRendererModule,
  backlogRendererModule,
  designRendererModule,
  devToolsRendererModule,
  memoryRendererModule,
  gitRendererModule,
  sprintEngineRendererModule,
  automationsRendererModule,
  mobileRelayRendererModule,
  voiceDictationRendererModule,
]

// Full bundled manifest list. Kept complete in every build channel: it backs
// the reserved-id drift guard (bundled-ids.test.ts) and the anti-impersonation
// set, so a third-party module can never claim a bundled id even in a build
// where the feature itself is absent. Do NOT narrow this to the active set.
export const BUNDLED_RENDERER_MODULE_MANIFESTS: ReadonlyArray<CapabilityManifest> =
  BUNDLED_RENDERER_MODULES.map((module) => module.manifest)

// True only in a real packaged (production) vite renderer build. We key on
// vite's `import.meta.env.PROD` rather than `DEV` on purpose: the unit-test
// bundles pass `--define:import.meta.env.DEV=false` (61 of them), which esbuild
// would fold into this gate and wrongly drop dev-only modules under test. No
// test defines `PROD`, so reading it defensively yields `false` everywhere
// except a genuine production build (where vite sets `PROD === true`), keeping
// the full module set active under both dev runs and tests. Do NOT "simplify"
// this back to `import.meta.env.DEV`.
const IS_PRODUCTION_BUILD: boolean = (import.meta as { env?: { PROD?: boolean } }).env?.PROD === true

// Active renderer modules for this build channel. Dev-only modules (Voice,
// Mobile Relay) are dropped from a
// packaged (production) renderer
// bundle so they are absent everywhere downstream: host registration, the
// enablement universe, profiles, and the Settings → Modules manager. In a dev
// build the full set is active and the modules remain user-toggleable. See
// src/shared/modules/dev-only.ts.

const ACTIVE_RENDERER_MODULES: ReadonlyArray<RendererModule> = activeForChannel(
  BUNDLED_RENDERER_MODULES,
  (module) => module.manifest.id,
  !IS_PRODUCTION_BUILD
)

export const ACTIVE_RENDERER_MODULE_MANIFESTS: ReadonlyArray<CapabilityManifest> =
  ACTIVE_RENDERER_MODULES.map((module) => module.manifest)

// Bundled modules that exist but are not active in this build channel — i.e. the
// feature-flagged (dev-only) modules in a production build; empty in a dev build
// where every bundled module is active. The Settings → Modules manager shows
// these as greyed-out "Coming soon" rows so users can see what's on the way
// without being able to turn them on (they are absent from the enablement
// universe, so they can never resolve enabled).
const ACTIVE_RENDERER_MODULE_IDS = new Set(ACTIVE_RENDERER_MODULE_MANIFESTS.map((m) => m.id))
export const COMING_SOON_MODULE_MANIFESTS: ReadonlyArray<CapabilityManifest> =
  BUNDLED_RENDERER_MODULE_MANIFESTS.filter((manifest) => !ACTIVE_RENDERER_MODULE_IDS.has(manifest.id))

// Eager singleton: registering a panel only stores a (lazy) component reference,
// so there's no render cost. The actual bundle loads when the panel renders.
// Each module registers through a scoped host so its panels record their owning
// module id (used by the factory to gate a host panel by enablement). Only the
// active set registers, so a dev-only module's panels/commands/settings never
// exist on the host in a production build.
const rendererHost = createRendererHost()
for (const module of ACTIVE_RENDERER_MODULES) {
  module.registerRenderer?.(rendererHost.hostFor(module.manifest.id))
}

// One shared empty namespace for a module that has never written app-level
// state. A stable reference, not a fresh `{}` per read: the app-state watcher
// compares the previous and next namespace by identity, and a new object each
// read would fire every subscriber on every unrelated store update.
const EMPTY_MODULE_APP_STATE: Readonly<Record<string, unknown>> = Object.freeze({})

// Same-keys-same-values, one level deep. The stored values are themselves stable
// references across an unrelated write, so this is the right depth: it answers
// "did MY namespace change?" without walking JSON the module owns.
function shallowEqualEntries(
  a: Readonly<Record<string, unknown>>,
  b: Readonly<Record<string, unknown>>
): boolean {
  if (a === b) return true
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => Object.is(a[key], b[key]))
}

// Host methods that gate on live enablement without a caller-supplied
// predicate (the Backlog read API) resolve it through this hook. The store
// import is deferred so the eager module-registry graph stays store-free
// (unit-test bundles construct this module without the store); until it lands
// (a microtask after boot, before the React root renders any panel) the
// kernel treats providers as enabled — and watches re-check on every
// delivery, so nothing started in that window outlives the resolver. The
// live-runtime surface factories (file watch, session watch, agent spawn)
// ride the same deferred batch: they are only constructed inside this wiring
// block, and importing them statically would drag them — and their transitive
// graph — into the eager boot chunk (the bundle-budget ratchet caught exactly
// that regression, MC-1535/T14).
if (typeof window !== 'undefined') {
  Promise.all([
    import('../store/workspaceStore'),
    import('../store/slices/settingsSlice'),
    import('../hooks/terminalSessionsStore'),
    import('../utils/modelRegistry'),
    import('../components/workspace/newWorkspace/cliRuntimeOptions'),
    import('../utils/agentNames'),
    import('../utils/workspaceWorktree'),
    import('./workspace-file-watch'),
    import('./agent-session-watch'),
    import('./agent-spawn'),
    import('./registry-snapshot'),
    import('./workspace-list-watch'),
    import('./color-scheme-watch'),
    import('../hooks/useAppTheme'),
    import('./workspace-opener'),
  ])
    .then(([{ useWorkspaceStore, workspaceRegistryReady, __workspaceStoreBackupRecoveryPromise }, { moduleSettingsNamespace }, terminalSessions, modelRegistry, cliRuntimeOptions, agentNames, workspaceWorktree, { createWorkspaceFileWatcher }, { createAgentSessionWatcher }, { createModuleAgentSpawner }, { buildModuleRegistrySnapshot, collectModuleSurfaces, startModuleRegistrySnapshotMirror }, { createWorkspaceListSource }, { createColorSchemeWatcher }, appTheme, { createWorkspaceOpener }]) => {
      rendererHost.setModuleEnablementResolver((moduleId) =>
        selectModuleEnabled(useWorkspaceStore.getState().appSettings.modules, moduleId)
      )
      const currentWindowId = new URL(window.location.href).searchParams.get('windowId')?.trim() || 'primary'
      const workspaceOpener = createWorkspaceOpener({
        ready: Promise.all([workspaceRegistryReady, __workspaceStoreBackupRecoveryPromise]).then(() => undefined),
        types: () => rendererHost.getWorkspaceTypes(),
        enabled: (moduleId) => selectModuleEnabled(useWorkspaceStore.getState().appSettings.modules, moduleId),
        isPrimaryWindow: () => currentWindowId === (useWorkspaceStore.getState().primaryWorkspaceWindowId || 'primary'),
        findWorkspace: (typeId) => useWorkspaceStore.getState().workspaces.find((workspace) => workspace.mode === typeId)?.id,
        createWorkspace: (type) => useWorkspaceStore.getState().addWorkspace(type.createTemplate(), {
          name: type.label,
          mode: type.id,
          folderPath: null,
          windowId: currentWindowId,
        }),
        focusWorkspace: (workspaceId) => {
          const state = useWorkspaceStore.getState()
          const owner = state.workspaceWindows.find((entry) => entry.workspaceIds.includes(workspaceId))?.id
          if (owner !== currentWindowId) state.moveWorkspaceToWindow(workspaceId, currentWindowId, owner)
          useWorkspaceStore.getState().setActiveWorkspaceForWindow(currentWindowId, workspaceId)
        },
        wasOpened: (moduleId, key) =>
          useWorkspaceStore.getState().appSettings.moduleSettings?.[moduleSettingsNamespace(moduleId)]?.[key] === true,
        markOpened: (moduleId, key) => useWorkspaceStore.getState().setModuleSettingValue(moduleId, key, true),
        onError: (typeId, error) => console.error(`[modules] could not open workspace type "${typeId}":`, error),
      })
      rendererHost.setWorkspaceOpener(workspaceOpener.open)
      onThirdPartyRendererModulesLoaded(() => { void workspaceOpener.openFirstLoads() })
      if (typeof window.api?.onThirdPartyModulesChanged === 'function') {
        window.api.onThirdPartyModulesChanged(() => {
          void refreshThirdPartyRendererModules().catch((error) => {
            console.error('[modules] could not refresh installed renderer modules:', error)
          })
        })
      }
      useWorkspaceStore.subscribe((state, previous) => {
        if (state.appSettings.modules !== previous.appSettings.modules) void workspaceOpener.openFirstLoads()
      })
      // Mirror the module registry to main (MC-2078), the same way enablement
      // is already mirrored: this process is the only one that knows the whole
      // universe (channel-narrowed bundled modules + loaded third-party ones)
      // and the overrides that resolve it, and main's `module.*` gateway tools
      // must report what the user sees rather than main's own half. It rides
      // the deferred batch above rather than a static import, like every other
      // wiring here — a top-level import would drag it into the eager boot
      // chunk the bundle-budget ratchet guards. Rebuilt
      // only when the overrides object changes identity — the store hands out a
      // new one exactly when enablement changes — and once more when the
      // third-party modules finish loading, which widens the universe.
      if (typeof window.api?.setModuleRegistrySnapshot === 'function') {
        const pushSnapshot = window.api.setModuleRegistrySnapshot
        startModuleRegistrySnapshotMirror({
          build: () =>
            buildModuleRegistrySnapshot({
              manifests: enablementUniverse(),
              overrides: useWorkspaceStore.getState().appSettings.modules ?? {},
              surfaces: collectModuleSurfaces(rendererHost),
              channel: IS_PRODUCTION_BUILD ? 'production' : 'development',
              now: Date.now(),
            }),
          push: async (snapshot) => {
            // A refused (malformed) or failed push is reported as undelivered so
            // the mirror re-sends it rather than treating it as landed; main
            // keeps whatever snapshot it already had.
            try {
              return (await pushSnapshot(snapshot)).ok !== false
            } catch {
              return false
            }
          },
          subscribe: (onChange) => {
            let lastOverrides = useWorkspaceStore.getState().appSettings.modules
            const stopStore = useWorkspaceStore.subscribe((state) => {
              if (state.appSettings.modules === lastOverrides) return
              lastOverrides = state.appSettings.modules
              onChange()
            })
            const stopThirdParty = onThirdPartyRendererModulesLoaded(onChange)
            return () => {
              stopStore()
              stopThirdParty()
            }
          },
        })
      }
      // Workspace-view source for RendererHost.getWorkspace: a fresh snapshot
      // object per lookup (never a store reference), null for unknown ids —
      // the same shared mapping the main-side WorkspaceContextToken uses.
      rendererHost.setWorkspaceResolver((workspaceId) => {
        const workspace = useWorkspaceStore.getState().workspaces.find((entry) => entry.id === workspaceId)
        return workspace ? toModuleWorkspaceView(workspace) : null
      })
      // The same mapping, one scope up: the whole open list, for a module
      // surface that is not mounted inside any one workspace.
      rendererHost.setWorkspaceListSource(
        createWorkspaceListSource({
          list: () =>
            useWorkspaceStore.getState().workspaces
              .map((workspace) => toModuleWorkspaceView(workspace))
              .filter((view): view is ModuleWorkspaceView => view !== null),
          subscribe: (cb) =>
            useWorkspaceStore.subscribe((state, prev) => {
              if (state.workspaces !== prev.workspaces) cb()
            }),
        })
      )
      // Resolved light/dark, from the appearance preference and — while it is
      // `system` — the OS media query: the same two inputs useResolvedColorScheme
      // reads, so a module's Monaco and the app's own agree.
      rendererHost.setColorSchemeWatcher(
        createColorSchemeWatcher({
          getScheme: () =>
            appTheme.resolvedColorScheme(useWorkspaceStore.getState().appSettings.appearance.theme),
          subscribe: (cb) => {
            const stopStore = useWorkspaceStore.subscribe((state, prev) => {
              if (state.appSettings.appearance.theme !== prev.appSettings.appearance.theme) cb()
            })
            // Always attached, whatever the preference: the watcher dedupes,
            // so an OS switch under an explicit theme costs one no-op read
            // and a `system` preference never misses one.
            const stopMedia = appTheme.subscribeSystemColorScheme(cb)
            return () => {
              stopStore()
              stopMedia()
            }
          },
        })
      )
      // Per-module workspace-state bag (MC-1573): reads come straight off the
      // store's `Workspace.moduleState`; writes go through the store action so
      // persistence and cross-window sync see them like any workspace field.
      rendererHost.setWorkspaceModuleStateStore({
        get: (workspaceId, moduleId) => {
          const workspace = useWorkspaceStore.getState().workspaces.find((entry) => entry.id === workspaceId)
          return workspace?.moduleState?.[moduleId]
        },
        set: (workspaceId, moduleId, state) =>
          useWorkspaceStore.getState().setWorkspaceModuleState(workspaceId, moduleId, state),
      })
      // App-level module state (MC-2090): the `module:<id>` namespace inside
      // app settings that already backs contributed Settings sections. Reads
      // are synchronous off the store — that is the whole point, so a module's
      // selector keeps its render timing — and writes go through the same
      // store action the Settings surface uses, so persistence is identical.
      rendererHost.setModuleAppStateStore({
        get: (moduleId) =>
          useWorkspaceStore.getState().appSettings.moduleSettings[
            moduleSettingsNamespace(moduleId)
          ] ?? EMPTY_MODULE_APP_STATE,
        set: (moduleId, key, value) => {
          if (moduleId.trim().length === 0 || key.trim().length === 0) return false
          useWorkspaceStore.getState().setModuleSettingValue(moduleId, key, value)
          return true
        },
        subscribe: (moduleId, cb) => {
          const namespace = moduleSettingsNamespace(moduleId)
          const read = (state: { appSettings: { moduleSettings: Record<string, Record<string, unknown>> } }) =>
            state.appSettings.moduleSettings[namespace] ?? EMPTY_MODULE_APP_STATE
          return useWorkspaceStore.subscribe((state, prev) => {
            const next = read(state)
            // Shallow by value, not by identity: the store's write action
            // renormalizes the WHOLE bag, so any module's write hands every
            // other module a fresh namespace object. Comparing identity would
            // wake every module's subscribers on every module's write — the
            // contract this surface documents is "fires when YOUR namespace
            // changes".
            if (!shallowEqualEntries(next, read(prev))) cb(next)
          })
        },
      })
      // One preload listener backs every module's subscriptions; the kernel
      // filters each envelope down to the module and topic that asked for it.
      if (typeof window.api?.onModuleEvent === 'function') {
        rendererHost.setModuleEventSource((cb) => window.api.onModuleEvent(cb))
      }
      // Effective working root (MC-1535): the worktree for worktree-backed
      // workspaces, the primary checkout otherwise. Every live-runtime surface
      // below resolves workspace-relative paths against this, never against
      // the durable folderPath the workspace view reports.
      const resolveWorkingRoot = (workspaceId: string): string | null => {
        const workspace = useWorkspaceStore.getState().workspaces.find((entry) => entry.id === workspaceId)
        return workspace ? workspaceWorktree.workspaceWorkingRoot(workspace) : null
      }
      rendererHost.setWorkingRootResolver(resolveWorkingRoot)
      // File-watch backend over the shell's fs watch plumbing (the same
      // window.api surface runStateSynchronizer rides).
      rendererHost.setWorkspaceFileWatcher(
        createWorkspaceFileWatcher({
          resolveFolderPath: resolveWorkingRoot,
          watchPath: (path, cb) => window.api.watchPath(path, cb),
          readFile: (path) => window.api.readfile(path),
        })
      )
      // Agent-session observation over the same terminal-sessions store the
      // shell's own surfaces consume.
      rendererHost.setAgentSessionWatcher(
        createAgentSessionWatcher({
          getSessions: terminalSessions.getTerminalSessionsSnapshot,
          subscribe: terminalSessions.subscribeTerminalSessions,
        })
      )
      // Agent spawn/focus/runtimes over the SHARED session runtime, the
      // layout tab helpers, and the availability-filtered CLI catalog.
      rendererHost.setAgentSpawner(
        createModuleAgentSpawner({
          getWorkspace: (workspaceId) => {
            const workspace = useWorkspaceStore.getState().workspaces.find((entry) => entry.id === workspaceId)
            if (!workspace) return null
            return {
              // Spawn cwd and file-tab base both target the working root, so
              // live ops land in the worktree a sprint workspace works under.
              folderPath: workspaceWorktree.workspaceWorkingRoot(workspace),
              agents: Object.entries(workspace.agents).map(([id, agent]) => ({ id, name: agent.name })),
            }
          },
          upsertAgent: (workspaceId, agentId, patch) => {
            useWorkspaceStore.getState().updateAgent(workspaceId, agentId, {
              name: patch.name,
              cli: patch.cli,
              ...(patch.cliModel ? { cliModel: patch.cliModel } : {}),
            })
          },
          removeAgent: (workspaceId, agentId) => {
            useWorkspaceStore.getState().removeAgent(workspaceId, agentId)
          },
          spawnTerminal: async (input) => {
            const state = useWorkspaceStore.getState()
            const agentName = state.workspaces
              .find((entry) => entry.id === input.workspaceId)?.agents[input.agentId]?.name
            // Mirror the shell spawn paths: an IPC rejection becomes a
            // structured failure — the module surface documents never-throw.
            const result = await window.api.terminalSpawn(
              input.sessionId,
              100,
              30,
              input.cwd,
              false,
              undefined,
              input.cli,
              input.prompt,
              state.appSettings.cliRuntimes,
              false,
              {
                kind: 'agent',
                workspaceId: input.workspaceId,
                agentId: input.agentId,
                ...(agentName ? { agentName } : {}),
                ...(input.cliModel ? { cliModel: input.cliModel } : {}),
                cliPermissionPreset: state.appSettings.lastAgentSpawnPermissionPreset ?? 'default',
                mcpSettings: state.appSettings.mcp,
              }
            ).catch((error): { ok: false; message: string } => ({
              ok: false,
              message: error instanceof Error ? error.message : 'Failed to start the agent session.',
            }))
            return { ok: result.ok, message: result.ok ? undefined : result.message }
          },
          revealAgentTab: (workspaceId, agentId, name) => {
            if (modelRegistry.focusOrAddAgentTab(workspaceId, agentId, name)) return
            const state = useWorkspaceStore.getState()
            const workspace = state.workspaces.find((entry) => entry.id === workspaceId)
            if (!workspace) return
            try {
              state.updateLayout(workspaceId, modelRegistry.ensureAgentTabInLayoutModel(workspace.layoutModel, agentId, name))
            } catch {
              // The session stays available even if layout persistence is busy.
            }
          },
          focusFileTab: (workspaceId, absolutePath) => modelRegistry.focusFileTab(workspaceId, absolutePath),
          listRuntimes: () => {
            const state = useWorkspaceStore.getState()
            const lastSelected = state.appSettings.lastSelectedCli ?? null
            return cliRuntimeOptions
              .selectAgentCliCatalog(
                state.pluginCatalogStatus,
                state.pluginCatalogEntries,
                state.appSettings.cliRuntimes,
                { map: state.cliAvailability, status: state.cliAvailabilityStatus },
                state.appSettings.cliModelCatalog,
                state.hostedModelCatalogs,
              )
              .map((option) => ({
                id: option.value,
                label: option.label,
                // The catalog is availability-filtered, so a row that is here
                // is installed unless detection explicitly said otherwise
                // (an option probed after it was added carries no entry yet).
                available: option.installed !== false,
                // Ids + labels only: the merged catalog's origin tags and
                // release dates are picker internals, not module contract.
                models: (option.modelSelection?.options ?? []).map((model) => ({
                  id: model.id,
                  label: model.label ?? model.id,
                })),
                isDefault: option.value === lastSelected,
              }))
          },
          defaultCli: () => useWorkspaceStore.getState().appSettings.lastSelectedCli ?? null,
          pickAgentName: (existing) => agentNames.pickRandomAgentName(existing),
          newAgentId: () => `agent-${crypto.randomUUID()}`,
          newSessionId: () => crypto.randomUUID(),
        })
      )
      // Boot measurement (MC-2075): the deferred batch above is the one part of
      // boot that was moved OUT of the eager chunk to satisfy the size ceiling,
      // so how long it takes to settle — and whether it lands before or after
      // first paint — is the evidence for whether that trade was worth making.
      markStartup('renderer.module-wiring-settled')
    })
    .catch((error) => {
      // Windowless bundles (unit tests) have no store; the kernel default
      // applies. Anything else here means module reads run unwired app-wide —
      // say so instead of failing silently.
      if (typeof document !== 'undefined') {
        console.error('[modules] failed to wire kernel resolvers from the workspace store:', error)
      }
    })
}

export function getRendererHost(): ReturnType<typeof createRendererHost> {
  return rendererHost
}

// Trusted third-party renderer modules join the same host and the same
// enablement universe as bundled modules. Initial loading runs before the
// React root renders; later install/trust changes can add renderer-only
// modules. Consumers are signalled after complete batches, never during a
// half-registered module; enablement toggles gate contributions
// reactively exactly like bundled ones — no reload. Only cleanly loaded
// modules' manifests enter the resolution universe (a module that failed
// mid-registration stays gated off everywhere).
let thirdPartyRendererManifests: ReadonlyArray<CapabilityManifest> = []

// Boot normally awaits loadThirdPartyRendererModules before the React root
// renders, but there is a timeout race: a slow load can land after first
// render. Registry-derived UI (panel scopes, command contributions)
// subscribes here so late-registered types still take effect without a reload.
let thirdPartyRendererModulesLoaded = false
const thirdPartyLoadedListeners = new Set<() => void>()

export function onThirdPartyRendererModulesLoaded(listener: () => void): () => void {
  thirdPartyLoadedListeners.add(listener)
  if (thirdPartyRendererModulesLoaded) {
    listener()
  }
  return () => {
    thirdPartyLoadedListeners.delete(listener)
  }
}

let rendererLoadQueue: Promise<void> = Promise.resolve()

export function loadThirdPartyRendererModules(): Promise<void> {
  rendererLoadQueue = rendererLoadQueue.catch(() => undefined).then(() => loadRendererModuleBatch(false))
  return rendererLoadQueue
}

/** Add newly installed renderer-only modules; never replace evaluated code. */
export function refreshThirdPartyRendererModules(): Promise<void> {
  rendererLoadQueue = rendererLoadQueue.catch(() => undefined).then(() => loadRendererModuleBatch(true))
  return rendererLoadQueue
}

/** Clear the conservative restart hint only for code this install activated. */
export async function installAndActivateRendererModules(
  install: () => Promise<MarketplacePluginRegistryInstallResult>
): Promise<MarketplacePluginRegistryInstallResult> {
  const previouslyLoaded = new Set(thirdPartyRendererManifests.map((manifest) => manifest.id))
  const result = await install()
  if (!result.ok) return result
  try {
    await refreshThirdPartyRendererModules()
  } catch (error) {
    console.error('[modules] renderer activation after install failed:', error)
    return result
  }
  const modules = result.installed.filter((component) => component.kind === 'module')
  const activated = modules.length > 0 && modules.every((component) =>
    !previouslyLoaded.has(component.id) && thirdPartyRendererManifests.some((manifest) =>
      manifest.id === component.id && !manifest.entry?.main && !manifest.entry?.preload))
  return activated && !result.updated ? { ...result, restartRequired: false } : result
}

async function loadRendererModuleBatch(refresh: boolean): Promise<void> {
  try {
    // Older preload bundles may not carry the bridge yet; treat that as "no
    // third-party renderer entries" rather than failing the boot.
    if (typeof window.api?.listThirdPartyRendererEntries !== 'function') return
    const served = await window.api.listThirdPartyRendererEntries()
    const { loadThirdPartyRendererEntries, rendererEntriesForRefresh } = await import('./third-party-loader')
    const loaded = await loadThirdPartyRendererEntries(rendererHost, refresh ? rendererEntriesForRefresh(served) : served)
    thirdPartyRendererManifests = [...thirdPartyRendererManifests, ...loaded]
    if (loaded.length > 0) {
      // The memoized enabled-set is keyed per overrides object; the universe just
      // changed, so any set resolved before the manifests landed is stale.
      enabledSetCache = new WeakMap()
    }
  } finally {
    thirdPartyRendererModulesLoaded = true
    for (const listener of [...thirdPartyLoadedListeners]) {
      try { listener() } catch (error) { console.error('[modules] registry listener failed:', error) }
    }
  }
}

// Resolving the module graph is pure but non-trivial (map build + dependency
// fixpoint + topo sort), and `selectModuleEnabled` runs inside many Zustand
// selectors on every store update. Memoize the resolved enabled-set per
// overrides object: the store hands out a new `appSettings.modules` reference
// only when enablement actually changes, so this is one resolution per change
// rather than one per call site per render.
let enabledSetCache = new WeakMap<object, Set<string>>()

function enablementUniverse(): CapabilityManifest[] {
  // Active set only: a dev-only module excluded from this build channel must not
  // resolve as enabled, so it never surfaces a panel, command, or workspace mode.
  return [...ACTIVE_RENDERER_MODULE_MANIFESTS, ...thirdPartyRendererManifests]
}

function enabledModuleSet(overrides: ModuleEnablementOverrides): Set<string> {
  if (!overrides || typeof overrides !== 'object') {
    return new Set(resolveModuleEnablement(enablementUniverse(), {}).order)
  }
  let set = enabledSetCache.get(overrides)
  if (!set) {
    set = new Set(resolveModuleEnablement(enablementUniverse(), overrides).order)
    enabledSetCache.set(overrides, set)
  }
  return set
}

// Reactive enablement selector for store subscriptions. Returns a boolean, so
// it's safe to use directly inside useWorkspaceStore selectors.
export function selectModuleEnabled(
  overrides: ModuleEnablementOverrides,
  moduleId: string
): boolean {
  return enabledModuleSet(overrides).has(moduleId)
}
