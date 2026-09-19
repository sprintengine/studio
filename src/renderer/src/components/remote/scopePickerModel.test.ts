import assert from 'node:assert/strict'

import { TAILNET_SCOPES, type TailnetScope } from '../../../../shared/tailnet'
import {
  READ_ONLY_SCOPES,
  SCOPE_ROWS,
  STANDARD_SCOPES,
  missingScopes,
  presetFor,
  scopesForPreset,
  terminalGapNote,
  toggleScope,
} from './scopePickerModel'
import { test } from 'vitest'

test('scopePickerModel', async () => {
  // The permission picker's rules, tested where they live.
  //
  // The acceptance criterion these exist for: the terminal tier is offered by
  // name on every pairing path, Standard includes it, and Read only includes the
  // half that makes a remote conversation visible.

  let failures = 0

  function check(name: string, run: () => void): void {
    try {
      run()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures++
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  check('one row per scope, in vocabulary order', () => {
    assert.deepEqual(
      SCOPE_ROWS.map((row) => row.scope),
      [...TAILNET_SCOPES],
    )
    // The identifier beside a title is always that row's own scope: a row whose
    // mono name named a different scope would be worse than no mono name.
    for (const row of SCOPE_ROWS) assert.equal(row.code, row.scope)
    for (const row of SCOPE_ROWS) {
      assert.ok(row.title.length > 0, `${row.scope} has a title`)
      assert.ok(row.description.endsWith('.'), `${row.scope}'s description is a sentence`)
    }
  })

  check('the terminal rows say what they are about', () => {
    const observe = SCOPE_ROWS.find((row) => row.scope === 'terminal:observe')
    const control = SCOPE_ROWS.find((row) => row.scope === 'terminal:control')
    // "Terminals — control" was the old wording, and it read as being about
    // shells; the scope also reveals every cross-machine conversation.
    assert.equal(observe?.title, 'Watch chats & terminals')
    assert.equal(control?.title, 'Drive chats & terminals')
    assert.match(control?.description ?? '', /Arbitrary shell on this machine/u)
  })

  check('read only is every :read plus terminal:observe', () => {
    assert.deepEqual([...READ_ONLY_SCOPES], ['workspace:read', 'backlog:read', 'terminal:observe'])
  })

  check('standard is every scope, terminal:control included', () => {
    // Owner ruling 2026-09-10. The whole point of the rebuild: a default that
    // quietly withheld the terminal tier is what hid remote chats.
    assert.deepEqual([...STANDARD_SCOPES], [...TAILNET_SCOPES])
    assert.ok(STANDARD_SCOPES.includes('terminal:control'))
  })

  check('presetFor names a set, whatever order it arrived in', () => {
    assert.equal(presetFor(scopesForPreset('standard')), 'standard')
    assert.equal(presetFor(scopesForPreset('read-only')), 'read-only')
    const shuffled: TailnetScope[] = ['terminal:observe', 'backlog:read', 'workspace:read']
    assert.equal(presetFor(shuffled), 'read-only')
  })

  check('a hand-picked set is neither preset', () => {
    assert.equal(presetFor(['workspace:read']), null)
    // Read only plus one operate scope: a superset of one preset and a subset of
    // the other, which is exactly the case a length comparison gets wrong.
    assert.equal(presetFor([...READ_ONLY_SCOPES, 'workspace:operate']), null)
    assert.equal(presetFor([]), null)
  })

  check('toggling keeps vocabulary order and is idempotent', () => {
    assert.deepEqual(toggleScope(['terminal:control'], 'workspace:read', true), ['workspace:read', 'terminal:control'])
    assert.deepEqual(toggleScope(['workspace:read'], 'workspace:read', true), ['workspace:read'])
    assert.deepEqual(toggleScope(['workspace:read'], 'workspace:read', false), [])
    assert.deepEqual(toggleScope([], 'workspace:read', false), [])
  })

  check('missingScopes is the complement, in vocabulary order', () => {
    assert.deepEqual(missingScopes(READ_ONLY_SCOPES), ['workspace:operate', 'backlog:operate', 'terminal:control'])
    assert.deepEqual(missingScopes(STANDARD_SCOPES), [])
  })

  check('the terminal note appears when EITHER terminal scope is missing', () => {
    assert.equal(terminalGapNote(STANDARD_SCOPES), null)
    const note = "It can't see chats or terminals here."
    assert.equal(terminalGapNote(READ_ONLY_SCOPES), note)
    assert.equal(terminalGapNote(missingScopes(['terminal:observe'])), note)
    assert.equal(terminalGapNote([]), note)
  })

  if (failures > 0) {
    console.error(`${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('scopePickerModel.test.ts: ok')
})
