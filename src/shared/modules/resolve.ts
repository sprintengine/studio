import type {
  CapabilityManifest,
  ModuleEnablementOverrides,
  ModuleResolution,
  ModuleResolutionError,
} from './manifest'

// Pure function: given the installed module manifests and the user's enablement
// overrides, decide which modules load, in what order, and why any are blocked.
//
// No I/O, no globals — the main/preload/renderer hosts and the eventual chooser
// UI all share this so "what's enabled" is computed identically everywhere.
export function resolveModuleEnablement(
  manifests: CapabilityManifest[],
  overrides: ModuleEnablementOverrides = {}
): ModuleResolution {
  const errors: ModuleResolutionError[] = []

  // 1. Index by id; first definition of an id wins.
  const byId = new Map<string, CapabilityManifest>()
  for (const manifest of manifests) {
    if (byId.has(manifest.id)) {
      errors.push({
        id: manifest.id,
        code: 'duplicate_id',
        message: `Duplicate module id "${manifest.id}"; ignoring the later definition.`,
      })
      continue
    }
    byId.set(manifest.id, manifest)
  }

  // 2. Desired enabled set from core flag / default / override.
  const desired = new Set<string>()
  for (const manifest of byId.values()) {
    const enabled = manifest.core ? true : (overrides[manifest.id] ?? manifest.defaultEnabled)
    if (enabled) desired.add(manifest.id)
  }

  // 3. Drop conflicting modules deterministically (sorted by id; later loser).
  const accepted = new Set<string>()
  for (const id of [...desired].sort()) {
    const manifest = byId.get(id)!
    const conflict = (manifest.conflictsWith ?? []).find((other) => accepted.has(other))
    if (conflict) {
      errors.push({
        id,
        code: 'conflict',
        message: `Module "${id}" conflicts with enabled module "${conflict}".`,
      })
      continue
    }
    accepted.add(id)
  }

  // 4. Dependency validation with cascading exclusion. Excluding a module can
  //    break a dependent, so iterate to a fixpoint.
  let changed = true
  while (changed) {
    changed = false
    for (const id of [...accepted]) {
      const manifest = byId.get(id)!
      for (const dep of manifest.dependsOn ?? []) {
        if (!byId.has(dep)) {
          errors.push({
            id,
            code: 'missing_dependency',
            message: `Module "${id}" requires "${dep}", which is not installed.`,
          })
          accepted.delete(id)
          changed = true
          break
        }
        if (!accepted.has(dep)) {
          errors.push({
            id,
            code: 'disabled_dependency',
            message: `Module "${id}" requires "${dep}", which is not enabled.`,
          })
          accepted.delete(id)
          changed = true
          break
        }
      }
    }
  }

  // 5. Topological order (dependencies first). Detect cycles defensively.
  const order: string[] = []
  const visiting = new Set<string>()
  const visited = new Set<string>()
  let cycleDetected = false

  const visit = (id: string): void => {
    if (visited.has(id)) return
    if (visiting.has(id)) {
      cycleDetected = true
      return
    }
    visiting.add(id)
    for (const dep of byId.get(id)!.dependsOn ?? []) {
      if (accepted.has(dep)) visit(dep)
    }
    visiting.delete(id)
    visited.add(id)
    order.push(id)
  }
  for (const id of [...accepted].sort()) visit(id)

  if (cycleDetected) {
    errors.push({
      id: '',
      code: 'dependency_cycle',
      message: 'Dependency cycle detected among enabled modules.',
    })
  }

  const erroredIds = new Set(errors.map((error) => error.id).filter((id) => id.length > 0))
  const disabled = [...byId.keys()]
    .filter((id) => !accepted.has(id) && !erroredIds.has(id))
    .sort()

  return {
    order: order.filter((id) => accepted.has(id)),
    disabled,
    errors,
  }
}
