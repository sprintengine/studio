import assert from 'node:assert/strict'

import type { SprintEngineRoleRegistry } from '../types/workspace'
import {
  SPECIALIST_ACTIONS,
  getSpecialistAction,
  orderSpecialistActions,
  synthesizeSpecialistAction,
} from './specialistActions'
import {
  BUNDLED_SPECIALIST_PACK_ID,
  discoveredSpecialistPacks,
  getBundledSpecialistPack,
  isSpecialistPackEnabled,
  listSpecialistPacks,
  resolveEnabledSpecialists,
} from './specialistPacks'

function registry(
  roles: Array<{ id: string; label: string; layer: string; summary?: string; icon?: string }>,
): SprintEngineRoleRegistry {
  return {
    roles: Object.fromEntries(
      roles.map((r) => [
        r.id,
        {
          id: r.id,
          label: r.label,
          aliases: [],
          summary: r.summary ?? null,
          icon: r.icon ?? null,
          source: { layer: r.layer },
        },
      ]),
    ),
    aliases: {},
    warnings: [],
  }
}

function main(): void {
  // The bundled pack wraps the full specialist roster.
  const bundled = getBundledSpecialistPack()
  assert.equal(bundled.id, BUNDLED_SPECIALIST_PACK_ID)
  assert.equal(bundled.builtin, true)
  assert.equal(bundled.specialists.length, SPECIALIST_ACTIONS.length)
  assert.equal(listSpecialistPacks().length, 1)

  // Enablement defaults to on; only explicit ids are disabled.
  assert.equal(isSpecialistPackEnabled(undefined, BUNDLED_SPECIALIST_PACK_ID), true)
  assert.equal(isSpecialistPackEnabled([], BUNDLED_SPECIALIST_PACK_ID), true)
  assert.equal(isSpecialistPackEnabled(['other'], BUNDLED_SPECIALIST_PACK_ID), true)
  assert.equal(isSpecialistPackEnabled([BUNDLED_SPECIALIST_PACK_ID], BUNDLED_SPECIALIST_PACK_ID), false)

  // No disabled packs → full roster.
  assert.equal(resolveEnabledSpecialists(undefined).length, SPECIALIST_ACTIONS.length)
  assert.equal(resolveEnabledSpecialists([]).length, SPECIALIST_ACTIONS.length)

  // Disabling the bundled pack empties the roster (the menu still has quick rows).
  assert.deepEqual(resolveEnabledSpecialists([BUNDLED_SPECIALIST_PACK_ID]), [])

  // Ordering applies to the enabled subset and never invents or drops entries.
  const enabled = resolveEnabledSpecialists(undefined)
  const ordered = orderSpecialistActions(['developer', 'architect'], enabled)
  assert.equal(ordered.length, enabled.length)
  assert.equal(ordered[0].id, 'developer')
  assert.equal(ordered[1].id, 'architect')
  assert.deepEqual(
    new Set(ordered.map((a) => a.id)),
    new Set(enabled.map((a) => a.id)),
    'ordering preserves the exact roster set',
  )

  // Ordering an empty roster yields an empty list, not the full catalog.
  assert.deepEqual(orderSpecialistActions(['developer'], []), [])

  // --- registry-discovered packs ---
  const reg = registry([
    // A truly new role on the workspace layer → its own discovered pack.
    { id: 'marketer', label: 'Marketer', layer: 'workspace', summary: 'Growth.' },
    // A new role on a plugin layer → a separate discovered pack.
    { id: 'translator', label: 'Translator', layer: 'plugin:lang' },
    // A bundled-layer role is represented by the bundled pack, not rediscovered.
    { id: 'developer', label: 'Developer', layer: 'bundled' },
    // An override of a bundled soul role (same id, higher layer) is skipped —
    // the bundled pack already represents it.
    { id: 'architect', label: 'My Architect', layer: 'user' },
  ])

  const discovered = discoveredSpecialistPacks(reg)
  const discoveredIds = discovered.map((p) => p.id).sort()
  assert.deepEqual(discoveredIds, ['registry:plugin:lang', 'registry:workspace'])
  for (const pack of discovered) assert.equal(pack.builtin, false)

  const marketer = discovered.find((p) => p.id === 'registry:workspace')!.specialists
  assert.equal(marketer.length, 1)
  assert.equal(marketer[0].id, 'marketer')
  assert.equal(marketer[0].soulRole, 'marketer', 'discovered soulRole is the registry role id')

  // No registry → bundled only; with registry → bundled + discovered.
  assert.equal(listSpecialistPacks().length, 1)
  assert.equal(listSpecialistPacks(reg).length, 3)

  // Enabled roster merges bundled + discovered; disabling a discovered pack
  // drops only its agents.
  const all = resolveEnabledSpecialists([], listSpecialistPacks(reg))
  assert.ok(all.some((s) => s.id === 'marketer'))
  assert.ok(all.some((s) => s.id === 'translator'))
  const withoutWorkspace = resolveEnabledSpecialists(['registry:workspace'], listSpecialistPacks(reg))
  assert.ok(!withoutWorkspace.some((s) => s.id === 'marketer'))
  assert.ok(withoutWorkspace.some((s) => s.id === 'translator'))

  // --- spawn resolution for discovered ids ---
  // A bundled id resolves to its curated action; any other id is treated as a
  // registry role id so `souls get <id>` renders its soul on spawn.
  const bundledAction = getSpecialistAction('developer')
  assert.equal(bundledAction.soulRole, 'developer')
  const discoveredAction = getSpecialistAction('marketer')
  assert.equal(discoveredAction.id, 'marketer')
  assert.equal(discoveredAction.soulRole, 'marketer', 'discovered id spawns via souls get <id>')
  assert.deepEqual(synthesizeSpecialistAction('translator'), {
    id: 'translator',
    label: 'translator',
    shortLabel: 'translator',
    description: '',
    icon: 'code',
    soulRole: 'translator',
  })
  // Empty input falls back to the first bundled action (never throws).
  assert.equal(getSpecialistAction(null).id, SPECIALIST_ACTIONS[0].id)
  assert.equal(getSpecialistAction(undefined).id, SPECIALIST_ACTIONS[0].id)

  console.log('specialistPacks.test.ts passed')
}

main()
