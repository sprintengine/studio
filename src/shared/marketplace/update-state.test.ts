import assert from 'node:assert/strict'

import { marketplaceUpdateAvailability, moduleUpdateState } from './update-state'

// The three detection states over (installed, latest) integer pairs.
assert.equal(moduleUpdateState(1, 2), 'update-available')
assert.equal(moduleUpdateState(1, 1), 'current')
assert.equal(moduleUpdateState(3, 2), 'ahead-of-registry')

// ahead-of-registry is its own state — never conflated with update-available
// (a dev build must not offer a downgrade as an update) and never an error.
assert.notEqual(moduleUpdateState(3, 2), 'update-available')
assert.equal(moduleUpdateState(2, 1), 'ahead-of-registry')

// Version 0 is a legal receipt version; the comparison stays plain integer.
assert.equal(moduleUpdateState(0, 1), 'update-available')
assert.equal(moduleUpdateState(0, 0), 'current')

// Large jumps are still one update-available, no range semantics.
assert.equal(moduleUpdateState(1, 100), 'update-available')

// Availability wrapping: a known latest carries both integers.
assert.deepEqual(marketplaceUpdateAvailability(1, 2), {
  state: 'update-available',
  installedVersion: 1,
  latestVersion: 2,
})
assert.deepEqual(marketplaceUpdateAvailability(2, 2), {
  state: 'current',
  installedVersion: 2,
  latestVersion: 2,
})
assert.deepEqual(marketplaceUpdateAvailability(3, 2), {
  state: 'ahead-of-registry',
  installedVersion: 3,
  latestVersion: 2,
})

// No registry entry for the id → unknown, distinct from current.
const missing = marketplaceUpdateAvailability(1, undefined)
assert.equal(missing.state, 'unknown')
assert.notEqual(missing.state, 'current')
if (missing.state === 'unknown') {
  assert.equal(missing.reason, 'not-in-registry')
  assert.equal(missing.installedVersion, 1)
}

console.log('marketplace update-state tests passed')
