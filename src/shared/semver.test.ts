import assert from 'node:assert/strict'

import { compareSemver, parseSemver } from './semver'
import { test } from 'vitest'

test('semver', async () => {
  assert.deepEqual(parseSemver('codex-cli 0.153.2'), { numbers: [0, 153, 2], prerelease: null })
  assert.deepEqual(parseSemver('2.1.261 (Claude Code)'), { numbers: [2, 1, 261], prerelease: null })
  assert.deepEqual(parseSemver('v1.18.27'), { numbers: [1, 18, 27], prerelease: null })
  assert.deepEqual(parseSemver('1.2.0-beta.1'), { numbers: [1, 2, 0], prerelease: 'beta.1' })
  assert.equal(parseSemver('grok'), null)
  assert.equal(parseSemver(null), null)

  assert.equal(compareSemver('0.153.2', '0.153.3'), -1)
  assert.equal(compareSemver('codex-cli 0.153.3', '0.153.3'), 0)
  assert.equal(compareSemver('2.1.261 (Claude Code)', '2.1.257'), 1)
  assert.equal(compareSemver('1.18', '1.18.0'), 0, 'a missing component is zero')
  assert.equal(compareSemver('1.2.0-beta.1', '1.2.0'), -1, 'a prerelease is below its release')
  assert.equal(compareSemver('1.2.0', '1.2.0-beta.1'), 1)
  assert.equal(compareSemver('1.2.0-alpha', '1.2.0-beta'), -1)
  assert.equal(compareSemver('10.0.0', '9.9.9'), 1, 'numeric, not lexical')
  assert.equal(compareSemver('unknown', '1.0.0'), null)
  assert.equal(compareSemver('1.0.0', null), null)

  console.log('semver: ok')
})
