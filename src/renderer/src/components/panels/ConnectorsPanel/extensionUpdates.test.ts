import assert from 'node:assert/strict'

import type { MarketplaceUpdateStatesResult } from '../../../../../shared/electron-api'
import type { MarketplacePluginEntry } from '../../../../../shared/marketplace/manifest'
import type { MarketplaceUpdateStateEntry } from '../../../../../shared/marketplace/update-state'
import {
  COULDNT_CHECK_COPY,
  cliOnlyRegistryIds,
  deriveManageUpdateBanner,
  manageUpdateBannerCopy,
} from './extensionUpdates'

// MC-1873 banner model: the owner ruling pinned the copy (name + delta, never
// a bare "Update available"), the collapse (several updates = one line), and
// the honesty states (couldn't-check ≠ up to date; ahead-of-registry is
// neither an update nor an error; CLI entries never claim a delta).

const none = new Set<string>()

function checkedResult(entries: MarketplaceUpdateStateEntry[]): MarketplaceUpdateStatesResult {
  return {
    ok: true,
    checked: true,
    registryState: 'ok',
    registrySource: 'network',
    stale: false,
    fetchedAt: '2026-08-01T00:00:00Z',
    entries,
  }
}

// --- update-available drives the banner, with the delta -------------------

{
  const banner = deriveManageUpdateBanner(
    checkedResult([
      {
        id: 'design-wizard',
        displayName: 'Design Wizard',
        availability: { state: 'update-available', installedVersion: 1, latestVersion: 2 },
      },
    ]),
    none,
  )
  assert.equal(banner.kind, 'updates')
  assert.ok(banner.kind === 'updates')
  const copy = manageUpdateBannerCopy(banner.updates)
  assert.equal(copy.strong, 'Design Wizard')
  assert.match(copy.text, /v1 → v2/)
  assert.equal(copy.actionLabel, 'Update to v2')
  // Never the bare phrase the ruling forbids.
  assert.doesNotMatch(copy.text, /^Update available$/)
  console.log('ok - single update carries the name and version delta')
}

// --- several pending updates collapse to one banner, never a stack --------

{
  const banner = deriveManageUpdateBanner(
    checkedResult([
      {
        id: 'a',
        displayName: 'A',
        availability: { state: 'update-available', installedVersion: 1, latestVersion: 2 },
      },
      {
        id: 'b',
        displayName: 'B',
        availability: { state: 'update-available', installedVersion: 3, latestVersion: 5 },
      },
    ]),
    none,
  )
  assert.ok(banner.kind === 'updates' && banner.updates.length === 2)
  const copy = manageUpdateBannerCopy(banner.updates)
  assert.equal(copy.strong, null)
  assert.equal(copy.text, 'Updates available · 2 extensions')
  assert.equal(copy.actionLabel, 'Update all')
  console.log('ok - multiple updates collapse to one banner')
}

// --- current and ahead-of-registry draw nothing ---------------------------

{
  const banner = deriveManageUpdateBanner(
    checkedResult([
      { id: 'a', displayName: 'A', availability: { state: 'current', installedVersion: 2, latestVersion: 2 } },
      // A local dev build past the registry: a real state, never an update
      // and never an error.
      {
        id: 'b',
        displayName: 'B',
        availability: { state: 'ahead-of-registry', installedVersion: 9, latestVersion: 2 },
      },
      // A purely local install with no registry entry: no claim either way.
      { id: 'c', displayName: 'C', availability: { state: 'unknown', installedVersion: 1, reason: 'not-in-registry' } },
    ]),
    none,
  )
  assert.equal(banner.kind, 'none')
  console.log('ok - current / ahead-of-registry / not-in-registry draw nothing')
}

// --- registry unreachable is couldn't-check, never "up to date" -----------

{
  const banner = deriveManageUpdateBanner(
    {
      ok: true,
      checked: false,
      registryState: 'offline',
      entries: [
        {
          id: 'a',
          displayName: 'A',
          availability: { state: 'unknown', installedVersion: 1, reason: 'registry-unreachable' },
        },
      ],
    },
    none,
  )
  assert.equal(banner.kind, 'couldnt-check')
  assert.match(COULDNT_CHECK_COPY, /check for updates/i)
  assert.doesNotMatch(COULDNT_CHECK_COPY, /up to date/i)
  // A failed local receipt read is the same honest state.
  assert.equal(deriveManageUpdateBanner({ ok: false, message: 'boom' }, none).kind, 'couldnt-check')
  // With nothing installed there is nothing to check — no line.
  assert.equal(
    deriveManageUpdateBanner({ ok: true, checked: false, registryState: 'offline', entries: [] }, none).kind,
    'none',
  )
  console.log("ok - unreachable registry renders couldn't-check, empty install set renders nothing")
}

// --- no read yet / unsupported build: no claim ----------------------------

assert.equal(deriveManageUpdateBanner(null, none).kind, 'none')
console.log('ok - no read yet draws nothing')

// --- cli-only entries never claim a delta (owner-pinned CLI split) --------

{
  const plugins = [
    { id: 'cursor', provides: ['cli'] },
    { id: 'design-wizard', provides: ['module'] },
    { id: 'combo', provides: ['cli', 'module'] },
  ] as unknown as MarketplacePluginEntry[]
  const excluded = cliOnlyRegistryIds(plugins)
  assert.deepEqual([...excluded], ['cursor'])
  const banner = deriveManageUpdateBanner(
    checkedResult([
      {
        id: 'cursor',
        displayName: 'Cursor',
        availability: { state: 'update-available', installedVersion: 1, latestVersion: 2 },
      },
    ]),
    excluded,
  )
  assert.equal(banner.kind, 'none')
  console.log('ok - cli-only registry entries are excluded from delta claims')
}

console.log('extensionUpdates model: all assertions passed')
