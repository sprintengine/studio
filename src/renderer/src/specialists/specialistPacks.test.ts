import assert from 'node:assert/strict'

import { SPECIALIST_ACTIONS, orderSpecialistActions } from './specialistActions'
import {
  BUNDLED_SPECIALIST_PACK_ID,
  getBundledSpecialistPack,
  isSpecialistPackEnabled,
  listSpecialistPacks,
  resolveEnabledSpecialists,
} from './specialistPacks'

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

  console.log('specialistPacks.test.ts passed')
}

main()
