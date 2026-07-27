import type {
  SprintEngineRoleRegistry,
  SprintEngineRoleRegistryMetadata,
} from '../types/workspace'
import type { SpecialistAction, SpecialistIcon } from './specialistActions'

// A specialist pack is a named, toggleable group of specialist agents. Nothing
// ships bundled: specialists are installed like anything else, so every pack is
// discovered from the role registry (the first-party pack installs into the
// user-global registry layer; workspace/plugin layers contribute their own).
// Not installed → no specialists in any picker, and the menu stays valid because
// the Terminal / General / Conversation quick rows always remain.
//
// Each agent's *soul* is composed from skills by the role registry (see
// sprintengine_core), and is portable: the Multicode product layer (Backlog,
// Knowledge Graph) and the Sprint Engine layer are composed on at spawn time,
// not baked into the soul.

export type SpecialistPack = {
  id: string
  name: string
  description: string
  /** Built-in packs ship with the app and cannot be uninstalled, only toggled. */
  builtin: boolean
  specialists: SpecialistAction[]
}

const SPECIALIST_ICONS: ReadonlySet<SpecialistIcon> = new Set<SpecialistIcon>([
  'architecture', 'code', 'design', 'design_review', 'review', 'spaghetti', 'nuclear',
  'shield', 'test', 'infra', 'product', 'performance', 'production_readiness',
  'cross_platform', 'writing',
])

function iconForRegistryRole(icon: string | null | undefined): SpecialistIcon {
  return icon && SPECIALIST_ICONS.has(icon as SpecialistIcon) ? (icon as SpecialistIcon) : 'code'
}

function specialistFromRegistryRole(role: SprintEngineRoleRegistryMetadata): SpecialistAction {
  // A discovered role's id is its registry role id, so its soul renders via
  // `souls get <id>`. Display comes from the manifest's label/description/icon.
  return {
    id: role.id,
    label: role.label,
    shortLabel: role.label,
    description: role.description ?? '',
    icon: iconForRegistryRole(role.icon),
    soulRole: role.id,
  }
}

const REGISTRY_PACK_ID_PREFIX = 'registry:'

function registryPackLabel(layer: string): string {
  if (layer === 'workspace') return 'Workspace specialists'
  if (layer === 'user') return 'User specialists'
  if (layer.startsWith('plugin:')) return `Plugin specialists — ${layer.slice('plugin:'.length)}`
  if (layer === 'plugin') return 'Plugin specialists'
  return `${layer} specialists`
}

/**
 * Specialist packs discovered from the role registry: every non-bundled-layer
 * role (workspace / user / plugin), grouped into a pack per source layer. The
 * `bundled` layer carries only host skills now (no role manifests), so nothing
 * is skipped — every discovered role surfaces as a specialist.
 */
export function discoveredSpecialistPacks(
  registry: SprintEngineRoleRegistry | null | undefined,
): SpecialistPack[] {
  if (!registry) return []
  const byLayer = new Map<string, SpecialistAction[]>()
  for (const role of Object.values(registry.roles)) {
    const layer = role.source?.layer
    if (!layer || layer === 'bundled') continue
    const list = byLayer.get(layer) ?? []
    list.push(specialistFromRegistryRole(role))
    byLayer.set(layer, list)
  }
  return [...byLayer.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([layer, specialists]) => ({
      id: `${REGISTRY_PACK_ID_PREFIX}${layer}`,
      name: registryPackLabel(layer),
      description: 'Specialist agents discovered from a plugged-in role registry layer.',
      builtin: false,
      specialists: specialists.sort((a, b) => a.label.localeCompare(b.label)),
    }))
}

/**
 * All specialist packs, sourced exclusively from the role registry. With no
 * registry (or an empty one) this is an empty list — a valid state: no pack
 * installed means no specialists, and every picker keeps its quick rows.
 */
export function listSpecialistPacks(
  registry?: SprintEngineRoleRegistry | null,
): SpecialistPack[] {
  return discoveredSpecialistPacks(registry)
}

// A pack is enabled unless its id is explicitly recorded as disabled, so a newly
// discovered pack defaults to on and an unknown disabled id is harmless.
export function isSpecialistPackEnabled(
  disabled: readonly string[] | undefined,
  packId: string,
): boolean {
  return !disabled?.includes(packId)
}

/**
 * The flattened specialist roster contributed by every enabled pack, de-duped
 * by id (first pack wins). Feeds the spawn dropdown; an empty result is valid
 * and the menu still offers its quick rows.
 */
export function resolveEnabledSpecialists(
  disabled: readonly string[] | undefined,
  packs: readonly SpecialistPack[] = listSpecialistPacks(),
): SpecialistAction[] {
  const seen = new Set<string>()
  const result: SpecialistAction[] = []
  for (const pack of packs) {
    if (!isSpecialistPackEnabled(disabled, pack.id)) continue
    for (const specialist of pack.specialists) {
      if (seen.has(specialist.id)) continue
      seen.add(specialist.id)
      result.push(specialist)
    }
  }
  return result
}
