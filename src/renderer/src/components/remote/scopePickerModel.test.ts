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

  check('each row names only what its scope grants', () => {
    const row = (scope: TailnetScope) => SCOPE_ROWS.find((candidate) => candidate.scope === scope)!
    // Chats belong to the conversation scopes alone: a terminal or workspace
    // row that mentioned them would read as granting `conversation:read`.
    for (const scope of TAILNET_SCOPES.filter((candidate) => !candidate.startsWith('conversation:')))
      assert.doesNotMatch(`${row(scope).title} ${row(scope).description}`, /chat|conversation/iu, scope)
    assert.equal(row('conversation:read').title, 'View conversations')
    assert.match(row('conversation:read').description, /chat transcripts/u)
    assert.equal(row('conversation:operate').title, 'Operate conversations')
    assert.equal(row('terminal:observe').title, 'Watch terminals')
    assert.equal(row('terminal:control').title, 'Drive terminals')
    assert.match(row('terminal:control').description, /Arbitrary shell on this machine/u)
  })

  check('read only is every :read plus terminal:observe', () => {
    assert.deepEqual([...READ_ONLY_SCOPES], ['workspace:read', 'backlog:read', 'conversation:read', 'terminal:observe'])
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
    const shuffled: TailnetScope[] = ['terminal:observe', 'conversation:read', 'backlog:read', 'workspace:read']
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
    assert.deepEqual(missingScopes(READ_ONLY_SCOPES), [
      'workspace:operate',
      'backlog:operate',
      'conversation:operate',
      'terminal:control',
    ])
    assert.deepEqual(missingScopes(STANDARD_SCOPES), [])
  })

  check('the terminal note says what the missing terminal scope costs', () => {
    assert.equal(terminalGapNote(STANDARD_SCOPES), null)
    // Control implies watching, so it alone leaves nothing out.
    assert.equal(terminalGapNote(['terminal:control']), null)
    assert.equal(terminalGapNote(READ_ONLY_SCOPES), 'It can watch terminals here but not type into them.')
    const blind = "It can't see terminals or terminal agents here."
    assert.equal(terminalGapNote(missingScopes(['terminal:observe', 'terminal:control'])), blind)
    assert.equal(terminalGapNote([]), blind)
  })

  if (failures > 0) {
    console.error(`${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('scopePickerModel.test.ts: ok')
})
