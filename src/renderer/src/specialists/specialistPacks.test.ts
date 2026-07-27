import assert from 'node:assert/strict'

import type { SprintEngineRoleRegistry } from '../types/workspace'
import {
  SPECIALIST_DISPLAY_ORDER,
  getSpecialistAction,
  orderSpecialistActions,
  synthesizeSpecialistAction,
  type SpecialistAction,
} from './specialistActions'
import {
  discoveredSpecialistPacks,
  isSpecialistPackEnabled,
  listSpecialistPacks,
  resolveEnabledSpecialists,
} from './specialistPacks'

function registry(
  roles: Array<{ id: string; label: string; layer: string; description?: string; icon?: string }>,
): SprintEngineRoleRegistry {
  return {
    roles: Object.fromEntries(
      roles.map((r) => [
        r.id,
        {
          id: r.id,
          label: r.label,
          aliases: [],
          description: r.description ?? null,
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
  // Nothing ships bundled: with no registry there are no packs and no
  // specialists, and that is a valid state (the pickers keep their quick rows).
  assert.deepEqual(listSpecialistPacks(), [])
  assert.deepEqual(listSpecialistPacks(null), [])
  assert.deepEqual(discoveredSpecialistPacks(undefined), [])
  assert.deepEqual(resolveEnabledSpecialists(undefined), [])
  assert.deepEqual(resolveEnabledSpecialists([]), [])

  // Enablement still defaults to on; only explicit ids are disabled.
  assert.equal(isSpecialistPackEnabled(undefined, 'registry:workspace'), true)
  assert.equal(isSpecialistPackEnabled([], 'registry:workspace'), true)
  assert.equal(isSpecialistPackEnabled(['other'], 'registry:workspace'), true)
  assert.equal(isSpecialistPackEnabled(['registry:workspace'], 'registry:workspace'), false)

  // --- registry-discovered packs ---
  const reg = registry([
    // A new role on the workspace layer → its own discovered pack.
    { id: 'marketer', label: 'Marketer', layer: 'workspace', description: 'Growth.', icon: 'product' },
    // A new role on a plugin layer → a separate discovered pack.
    { id: 'translator', label: 'Translator', layer: 'plugin:lang' },
    // A bundled-layer entry carries only host skills now (no role manifests);
    // it is never surfaced as a specialist.
    { id: 'sprintengine_workflow', label: 'Workflow', layer: 'bundled' },
    // The first-party specialist pack installs into the user layer → discovered
    // like any other pack (no bundled catalog to skip against).
    { id: 'architect', label: 'Architect', layer: 'user', icon: 'architecture' },
    { id: 'frontend', label: 'Frontend Designer', layer: 'user', icon: 'design' },
  ])

  const discovered = discoveredSpecialistPacks(reg)
  const discoveredIds = discovered.map((p) => p.id).sort()
  assert.deepEqual(discoveredIds, ['registry:plugin:lang', 'registry:user', 'registry:workspace'])
  for (const pack of discovered) assert.equal(pack.builtin, false)

  const marketer = discovered.find((p) => p.id === 'registry:workspace')!.specialists
  assert.equal(marketer.length, 1)
  assert.equal(marketer[0].id, 'marketer')
  assert.equal(marketer[0].soulRole, 'marketer', 'discovered soulRole is the registry role id')
  assert.equal(marketer[0].icon, 'product', 'discovered icon comes from the manifest')

  // The user-layer first-party roles surface with their manifest metadata.
  const userPack = discovered.find((p) => p.id === 'registry:user')!.specialists
  assert.deepEqual(new Set(userPack.map((s) => s.id)), new Set(['architect', 'frontend']))

  // No registry → no packs; with registry → one pack per source layer.
  assert.equal(listSpecialistPacks().length, 0)
  assert.equal(listSpecialistPacks(reg).length, 3)

  // Enabled roster merges every discovered pack; disabling one drops only its
  // agents.
  const all = resolveEnabledSpecialists([], listSpecialistPacks(reg))
  assert.ok(all.some((s) => s.id === 'marketer'))
  assert.ok(all.some((s) => s.id === 'translator'))
  assert.ok(all.some((s) => s.id === 'architect'))
  const withoutWorkspace = resolveEnabledSpecialists(['registry:workspace'], listSpecialistPacks(reg))
  assert.ok(!withoutWorkspace.some((s) => s.id === 'marketer'))
  assert.ok(withoutWorkspace.some((s) => s.id === 'translator'))

  // --- spawn resolution: every id is a registry role id (id === soulRole) ---
  const developerAction = getSpecialistAction('developer')
  assert.equal(developerAction.id, 'developer')
  assert.equal(developerAction.soulRole, 'developer', 'id spawns via souls get <id>')
  assert.deepEqual(synthesizeSpecialistAction('translator'), {
    id: 'translator',
    label: 'translator',
    shortLabel: 'translator',
    description: '',
    icon: 'code',
    soulRole: 'translator',
  })
  // Empty input yields a neutral placeholder instead of throwing.
  assert.equal(getSpecialistAction(null).id, '')
  assert.equal(getSpecialistAction(undefined).id, '')

  // --- ordering ---
  // A user-defined order leads; the curated display order sequences the rest of
  // the known roles; anything unknown appends last. Never adds or drops.
  const actions: SpecialistAction[] = [
    synthesizeSpecialistAction('tester'),
    synthesizeSpecialistAction('architect'),
    synthesizeSpecialistAction('zzz-custom'),
    synthesizeSpecialistAction('developer'),
  ]
  const ordered = orderSpecialistActions(['developer'], actions)
  assert.equal(ordered.length, actions.length, 'ordering preserves the exact roster set')
  assert.equal(ordered[0].id, 'developer', 'the saved order leads')
  // architect precedes tester in SPECIALIST_DISPLAY_ORDER, so the curated order
  // sequences the remaining known roles even though the input order differs.
  const architectIdx = ordered.findIndex((a) => a.id === 'architect')
  const testerIdx = ordered.findIndex((a) => a.id === 'tester')
  assert.ok(architectIdx < testerIdx, 'curated order preserves architect-before-tester')
  assert.equal(ordered[ordered.length - 1].id, 'zzz-custom', 'unknown roles append last')
  assert.deepEqual(
    new Set(ordered.map((a) => a.id)),
    new Set(actions.map((a) => a.id)),
    'ordering never invents or drops entries',
  )

  // Ordering an empty roster yields an empty list.
  assert.deepEqual(orderSpecialistActions(['developer'], []), [])

  // The curated order mirrors today's roster by registry role id.
  assert.equal(SPECIALIST_DISPLAY_ORDER[0], 'architect')
  assert.ok(SPECIALIST_DISPLAY_ORDER.includes('tester'))
  assert.ok(SPECIALIST_DISPLAY_ORDER.includes('security'))
  assert.ok(!SPECIALIST_DISPLAY_ORDER.includes('qa-test'), 'no retired action ids remain')

  console.log('specialistPacks.test.ts passed')
}

main()
