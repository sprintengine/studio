import { SPECIALIST_ACTIONS, type SpecialistAction } from './specialistActions'

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

/** All packs Multicode knows about. Today this is the single bundled pack. */
export function listSpecialistPacks(): SpecialistPack[] {
  return [getBundledSpecialistPack()]
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
