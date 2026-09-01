// Renderer half of the module-registry mirror (MC-2078).
//
// The renderer holds the whole module universe — bundled modules already
// narrowed to the build channel, plus the trusted third-party ones it loaded —
// and the enablement overrides that decide what resolves. Main holds only its
// own half, so anything outside the renderer that must answer "which modules
// does this app have, and is one of them on?" reads this projection instead of
// deriving a second answer. See shared/modules/registry-snapshot.ts for the
// contract and why it is a mirror rather than a main-side registry.
//
// Everything here is pure over its inputs except the mirror loop at the bottom,
// which is the only part that touches the store or the preload bridge.

import type {
  CapabilityManifest,
  ModuleEnablementOverrides,
  ModuleResolutionError,
} from '../../../shared/modules/manifest'
import {
  EMPTY_MODULE_SURFACES,
  type ModuleBuildChannel,
  type ModuleContributedSurfaces,
  type ModuleRegistryEntry,
  type ModuleRegistrySnapshot,
} from '../../../shared/modules/registry-snapshot'
import { resolveModuleEnablement } from '../../../shared/modules/resolve'

// The kernel getters this projection reads, structurally — so a test fakes the
// registry with plain objects instead of standing up the real host. Each is
// called with no enablement predicate on purpose: the snapshot reports what a
// module CONTRIBUTES, and gating it by enablement would make a disabled
// module's surfaces silently vanish from the very report that explains why the
// module is off.
export type ModuleSurfaceRegistry = {
  getWorkspaceTypes(moduleEnabled?: (moduleId: string) => boolean): ReadonlyArray<{ id: string; moduleId: string }>
  getGlobalSurfaces(moduleEnabled?: (moduleId: string) => boolean): ReadonlyArray<{ id: string; moduleId: string }>
  getModalSurfaces(moduleEnabled?: (moduleId: string) => boolean): ReadonlyArray<{ id: string; moduleId: string }>
  getSidebarNavEntries(moduleEnabled?: (moduleId: string) => boolean): ReadonlyArray<{ id: string; moduleId: string }>
  getSettingsSections(moduleEnabled?: (moduleId: string) => boolean): ReadonlyArray<{ id: string; moduleId: string }>
  getModuleCommands(moduleEnabled?: (moduleId: string) => boolean): ReadonlyArray<{ id: string; moduleId: string }>
  getTopBarItems(moduleEnabled?: (moduleId: string) => boolean): ReadonlyArray<{ id: string; moduleId: string }>
  getBacklogItemActions(): ReadonlyArray<{ id: string; moduleId: string }>
  getWorkspaceAside(): { id: string; moduleId: string } | undefined
}

export function collectModuleSurfaces(registry: ModuleSurfaceRegistry): Record<string, ModuleContributedSurfaces> {
  const byModule: Record<string, ModuleContributedSurfaces> = {}
  const surfacesFor = (moduleId: string): ModuleContributedSurfaces => {
    const existing = byModule[moduleId]
    if (existing) return existing
    const created: ModuleContributedSurfaces = {
      workspaceTypes: [],
      globalSurfaces: [],
      modalSurfaces: [],
      sidebarNavEntries: [],
      settingsSections: [],
      commands: [],
      topBarItems: [],
      backlogItemActions: [],
      workspaceAsides: [],
    }
    byModule[moduleId] = created
    return created
  }
  const collect = (
    kind: keyof ModuleContributedSurfaces,
    registered: ReadonlyArray<{ id: string; moduleId: string }>
  ): void => {
    for (const entry of registered) surfacesFor(entry.moduleId)[kind].push(entry.id)
  }
  collect('workspaceTypes', registry.getWorkspaceTypes())
  collect('globalSurfaces', registry.getGlobalSurfaces())
  collect('modalSurfaces', registry.getModalSurfaces())
  collect('sidebarNavEntries', registry.getSidebarNavEntries())
  collect('settingsSections', registry.getSettingsSections())
  collect('commands', registry.getModuleCommands())
  collect('topBarItems', registry.getTopBarItems())
  collect('backlogItemActions', registry.getBacklogItemActions())
  const aside = registry.getWorkspaceAside()
  if (aside) collect('workspaceAsides', [aside])
  return byModule
}

export function buildModuleRegistrySnapshot(input: {
  /** The enablement universe: active bundled manifests plus loaded third-party ones. */
  manifests: ReadonlyArray<CapabilityManifest>
  overrides: ModuleEnablementOverrides
  surfaces: Record<string, ModuleContributedSurfaces>
  channel: ModuleBuildChannel
  now: number
}): ModuleRegistrySnapshot {
  // The same resolver the app gates surfaces with, over the same universe — so
  // "enabled" here means exactly what it means to a panel or a door.
  const resolution = resolveModuleEnablement([...input.manifests], input.overrides)
  const enabled = new Set(resolution.order)
  const blockedBy = new Map<string, ModuleResolutionError>()
  for (const error of resolution.errors) {
    if (error.id.length === 0 || blockedBy.has(error.id)) continue
    blockedBy.set(error.id, error)
  }
  const modules: ModuleRegistryEntry[] = input.manifests.map((manifest) => {
    const isEnabled = enabled.has(manifest.id)
    const blocker = blockedBy.get(manifest.id)
    return {
      id: manifest.id,
      manifest,
      source: manifest.source ?? 'bundled',
      enabled: isEnabled,
      absence: isEnabled
        ? null
        : blocker
          ? { reason: blocker.code, message: blocker.message }
          : { reason: 'disabled', message: `Module "${manifest.id}" is not enabled (Settings → Modules).` },
      surfaces: input.surfaces[manifest.id] ?? { ...EMPTY_MODULE_SURFACES },
    }
  })
  return { capturedAt: input.now, channel: input.channel, modules }
}

/**
 * Push the snapshot on start and on every change, deduped by content. The
 * timestamp is excluded from the comparison so an unchanged registry is not
 * re-sent by an unrelated store write. Returns the unsubscribe.
 */
export function startModuleRegistrySnapshotMirror(input: {
  build: () => ModuleRegistrySnapshot
  /** Delivers the snapshot; resolves false when it did not land. */
  push: (snapshot: ModuleRegistrySnapshot) => boolean | Promise<boolean>
  /** Fires when something the snapshot depends on changed. */
  subscribe: (onChange: () => void) => () => void
}): () => void {
  let lastSerialized = ''
  const send = (): void => {
    const snapshot = input.build()
    const serialized = JSON.stringify({ ...snapshot, capturedAt: 0 })
    if (serialized === lastSerialized) return
    lastSerialized = serialized
    void Promise.resolve(input.push(snapshot)).then((accepted) => {
      // A push that failed or was refused must not be remembered as delivered:
      // dedupe would then suppress the identical retry, and the reader would sit
      // on a stale (or absent) registry until something unrelated changed.
      if (!accepted && lastSerialized === serialized) lastSerialized = ''
    })
  }
  send()
  return input.subscribe(send)
}
