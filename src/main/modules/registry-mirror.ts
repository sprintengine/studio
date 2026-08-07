import {
  normalizeModuleRegistrySnapshot,
  type ModuleRegistrySnapshot,
  type ModuleRegistrySnapshotWriteResult,
} from '../../shared/modules/registry-snapshot'

// Main's cache of the renderer's module registry (MC-2078). In-memory only and
// deliberately not persisted: it is a projection of live renderer state, so a
// value surviving a restart would describe a registry nobody has confirmed. A
// consumer reading `null` has not been told yet and must say so rather than
// report an empty registry — the same discipline as the module-enablement
// mirror, which starts out knowing nothing and gates everything off.

export type ModuleRegistryMirror = {
  /** The last accepted snapshot, or null before the renderer has pushed one. */
  read(): ModuleRegistrySnapshot | null
  /** Accept a push. A malformed payload is refused; the cached snapshot stands. */
  write(value: unknown): ModuleRegistrySnapshotWriteResult
}

export function createModuleRegistryMirror(): ModuleRegistryMirror {
  let snapshot: ModuleRegistrySnapshot | null = null
  return {
    read: () => snapshot,
    write(value) {
      const normalized = normalizeModuleRegistrySnapshot(value)
      if (!normalized) {
        return { ok: false, message: 'Malformed module registry snapshot; the cached registry is unchanged.' }
      }
      snapshot = normalized
      return { ok: true }
    },
  }
}
