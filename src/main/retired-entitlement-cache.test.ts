import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { test } from 'vitest'

import { IDENTITY_MARKER_FILE_NAME, REFRESH_TOKEN_FILE_NAMES } from './desktop-identity'
import { RETIRED_ENTITLEMENT_CACHE_FILE_NAME, removeRetiredEntitlementCache } from './retired-entitlement-cache'

async function userData(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'sprintengine-retired-entitlements-'))
}

test('removes the cached entitlement snapshot', async () => {
  const dir = await userData()
  await writeFile(
    join(dir, RETIRED_ENTITLEMENT_CACHE_FILE_NAME),
    JSON.stringify({
      snapshot: { plan: { code: 'pro', status: 'active' } },
      lastRefreshAt: '2026-09-01T00:00:00.000Z',
    }),
  )

  assert.deepEqual(await removeRetiredEntitlementCache(dir), { outcome: 'done' })
  assert.deepEqual(await readdir(dir), [])
})

test('never touches the sign-in or the rest of userData', async () => {
  const dir = await userData()
  const kept: Record<string, string> = {
    [REFRESH_TOKEN_FILE_NAMES.multiauth]: 'encrypted-multiauth-token',
    [REFRESH_TOKEN_FILE_NAMES.clerk]: 'encrypted-clerk-token',
    [IDENTITY_MARKER_FILE_NAME]: JSON.stringify({ provider: 'clerk' }),
    'multiauth-account-cache.json': JSON.stringify({ user: { id: 'u1', email: 'dev@example.com' } }),
    'multiauth-account-photo.json': '{}',
    'settings.json': '{}',
  }
  for (const [name, content] of Object.entries(kept)) await writeFile(join(dir, name), content)
  await writeFile(join(dir, RETIRED_ENTITLEMENT_CACHE_FILE_NAME), '{}')

  await removeRetiredEntitlementCache(dir)

  assert.deepEqual((await readdir(dir)).sort(), Object.keys(kept).sort())
  for (const [name, content] of Object.entries(kept)) {
    assert.equal(await readFile(join(dir, name), 'utf8'), content, name)
  }
})

test('is a no-op once the file is gone, so running it every launch is safe', async () => {
  const dir = await userData()
  assert.deepEqual(await removeRetiredEntitlementCache(dir), { outcome: 'done' })
  assert.deepEqual(await removeRetiredEntitlementCache(dir), { outcome: 'done' })
})
