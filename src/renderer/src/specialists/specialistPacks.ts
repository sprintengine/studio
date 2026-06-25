import type {
  SprintEngineRoleRegistry,
  SprintEngineRoleRegistryMetadata,
} from '../types/workspace'
import {
  SPECIALIST_ACTIONS,
  type SpecialistAction,
  type SpecialistIcon,
} from './specialistActions'

// A specialist pack is a named, toggleable group of specialist agents. The
// built-in roster ships as the "Multicode Specialists" pack; deselecting it
// removes its agents from the spawn dropdown without ever emptying the menu
// (the Terminal / General / Conversation quick rows always remain).
//
// Each agent's *soul* is composed from skills by the role registry (see
// sprintengine_core), and is portable: the Multicode product layer (Backlog,
// Knowledge Graph) and the Sprint Engine layer are composed on at spawn time,
// not baked into the soul. Surfacing user/plugin registry packs in this
// dropdown additionally requires widening the specialist id space (it is keyed
// by a fixed union today, used by watchtower focus mapping and the main-process
// soul service); that migration is tracked separately.
export const BUNDLED_SPECIALIST_PACK_ID = 'multicode-specialists'

export type SpecialistPack = {
  id: string
  name: string
  description: string
  /** Built-in packs ship with the app and cannot be uninstalled, only toggled. */
  builtin: boolean
  specialists: SpecialistAction[]
}

export function getBundledSpecialistPack(): SpecialistPack {
  return {
    id: BUNDLED_SPECIALIST_PACK_ID,
    name: 'Multicode Specialists',
    description:
      'The built-in specialist roster shipped with Multicode — architecture, development, review, testing, security, and more.',
    builtin: true,
    specialists: SPECIALIST_ACTIONS,
  }
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
  // `souls get <id>`. Display comes from the manifest's label/summary/icon.
  return {
    id: role.id,
    label: role.label,
    shortLabel: role.label,
    description: role.summary ?? '',
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
 * role (workspace / user / plugin), grouped into a pack per source layer. Roles
 * whose id overlaps a bundled specialist's soul role are skipped — the bundled
 * pack already represents them (a higher-precedence override still renders
 * through `souls get` at spawn time).
 */
export function discoveredSpecialistPacks(
  registry: SprintEngineRoleRegistry | null | undefined,
): SpecialistPack[] {
  if (!registry) return []
  const bundledSoulRoles = new Set(SPECIALIST_ACTIONS.map((action) => action.soulRole))
  const byLayer = new Map<string, SpecialistAction[]>()
  for (const role of Object.values(registry.roles)) {
    const layer = role.source?.layer
    if (!layer || layer === 'bundled') continue
    if (bundledSoulRoles.has(role.id)) continue
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
 * All packs: the bundled pack plus any registry-discovered packs. Pass the
 * loaded role registry to surface dropped-in specialist packs; omit it for the
 * bundled-only roster.
 */
export function listSpecialistPacks(
  registry?: SprintEngineRoleRegistry | null,
): SpecialistPack[] {
  return [getBundledSpecialistPack(), ...discoveredSpecialistPacks(registry)]
}

// A pack is enabled unless its id is explicitly recorded as disabled, so a new
// pack (including the bundled one on first run) defaults to on and an unknown
// disabled id is harmless.
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
