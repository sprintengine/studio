import assert from 'node:assert/strict'

import {
  isAbsoluteObservedPath,
  observedCheckoutKind,
  parseObservedCheckout,
  sameObservedCheckout,
  unresolvedObservedCheckout,
} from './observed-checkout'
import { test } from 'vitest'

test('observed-checkout', async () => {
  // Pure contract of the observed checkout (MC-2440): what counts as an absolute
  // cwd on any platform, how a persisted observation is read back as untrusted
  // input, and how a consumer classifies one.

  // --- absolute paths -------------------------------------------------------
  assert.equal(isAbsoluteObservedPath('/'), true)
  assert.equal(isAbsoluteObservedPath('/Users/me'), true)
  assert.equal(isAbsoluteObservedPath('C:\\Users\\me'), true)
  assert.equal(isAbsoluteObservedPath('c:/Users/me'), true)
  assert.equal(isAbsoluteObservedPath('\\\\server\\share'), true)
  assert.equal(isAbsoluteObservedPath('\\\\'), false, 'a bare UNC prefix names nothing')
  assert.equal(isAbsoluteObservedPath('C:'), false, 'a drive with no separator is not a path')
  assert.equal(isAbsoluteObservedPath('C:Users'), false)
  assert.equal(isAbsoluteObservedPath(''), false)
  assert.equal(isAbsoluteObservedPath('relative/dir'), false)
  assert.equal(isAbsoluteObservedPath('~/dir'), false)

  // --- persisted observation, read back ----------------------------------------
  assert.equal(parseObservedCheckout(null), null)
  assert.equal(parseObservedCheckout('x'), null)
  assert.equal(parseObservedCheckout({}), null)
  assert.equal(parseObservedCheckout({ cwd: 'relative', at: 1 }), null, 'a relative cwd is rejected')
  assert.equal(parseObservedCheckout({ cwd: '/repo', at: 'now' }), null, 'at must be a finite number')
  assert.equal(parseObservedCheckout({ cwd: '/repo', at: Number.NaN }), null)
  assert.deepEqual(
    parseObservedCheckout({ cwd: '/repo', at: 5 }),
    unresolvedObservedCheckout('/repo', 5),
    'no resolved flag reads as unresolved',
  )
  assert.deepEqual(
    parseObservedCheckout({
      cwd: '/repo',
      at: 5,
      resolved: true,
      gitRoot: '/repo',
      repoRoot: '/repo',
      branch: 'main',
      isLinkedWorktree: false,
    }),
    {
      cwd: '/repo',
      at: 5,
      resolved: true,
      gitRoot: '/repo',
      repoRoot: '/repo',
      branch: 'main',
      isLinkedWorktree: false,
    },
  )
  assert.deepEqual(
    parseObservedCheckout({
      cwd: '/repo',
      at: 5,
      resolved: true,
      gitRoot: null,
      repoRoot: '/x',
      branch: 'main',
      isLinkedWorktree: true,
    }),
    { cwd: '/repo', at: 5, resolved: true, gitRoot: null, repoRoot: null, branch: null, isLinkedWorktree: false },
    'without a git root there is no repo root, branch or worktree-ness',
  )
  assert.equal(
    parseObservedCheckout({ cwd: '/repo', at: 5, resolved: true, gitRoot: 'relative', branch: 'main' })?.gitRoot,
    null,
    'a relative git root is rejected',
  )
  assert.equal(
    parseObservedCheckout({ cwd: '/repo', at: 5, resolved: true, gitRoot: '/repo', branch: 'x'.repeat(600) })?.branch,
    null,
    'an absurd branch is dropped',
  )
  assert.equal(parseObservedCheckout({ cwd: '/' + 'x'.repeat(5000), at: 5 }), null, 'an oversized cwd is rejected')

  // --- equality ----------------------------------------------------------------
  const a = unresolvedObservedCheckout('/repo', 5)
  assert.equal(sameObservedCheckout(a, { ...a }), true)
  assert.equal(sameObservedCheckout(a, { ...a, resolved: true }), false)
  assert.equal(sameObservedCheckout(a, { ...a, branch: 'main' }), false)
  assert.equal(sameObservedCheckout(null, undefined), true)
  assert.equal(sameObservedCheckout(a, null), false)

  // --- classification ------------------------------------------------------------
  assert.equal(observedCheckoutKind(undefined), 'unknown')
  assert.equal(observedCheckoutKind(a), 'unknown', 'unresolved is unknown — consumers fall back to launch intent')
  assert.equal(observedCheckoutKind({ ...a, resolved: true }), 'folder')
  assert.equal(observedCheckoutKind({ ...a, resolved: true, missing: true }), 'missing')
  assert.equal(
    observedCheckoutKind({ ...a, resolved: true, gitRoot: '/repo', missing: true }),
    'main',
    'missing only means something without a git root',
  )
  assert.equal(
    parseObservedCheckout({ cwd: '/gone', at: 5, resolved: true, gitRoot: null, missing: true })?.missing,
    true,
  )
  assert.equal(
    parseObservedCheckout({ cwd: '/repo', at: 5, resolved: true, gitRoot: '/repo', missing: true })?.missing,
    undefined,
  )
  assert.equal(sameObservedCheckout({ ...a, resolved: true }, { ...a, resolved: true, missing: true }), false)
  assert.equal(observedCheckoutKind({ ...a, resolved: true, gitRoot: '/repo' }), 'main')
  assert.equal(observedCheckoutKind({ ...a, resolved: true, gitRoot: '/wt', isLinkedWorktree: true }), 'worktree')

  console.log('observed-checkout.test.ts: all assertions passed')
})
