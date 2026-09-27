import { rm } from 'fs/promises'
import { join } from 'path'

// Signed-in desktops used to cache the account's entitlement snapshot — its
// plan, its feature keys, when it was last checked — in one file in userData,
// so a paid feature kept working offline. There is no paywall any more (owner
// ruling 2026-09-27): the app is open source, nothing reads an entitlement, and
// a record of what an account paid for has no reason to stay on disk.
//
// Deleted at start, and only this file. The sign-in itself lives elsewhere and
// is never touched here: the refresh tokens (`REFRESH_TOKEN_FILE_NAMES`), the
// identity marker, and the cached account profile and photo all stay, so a
// signed-in user is still signed in after the update. Safe on every launch:
// once the file is gone this is a no-op.

export const RETIRED_ENTITLEMENT_CACHE_FILE_NAME = 'multiauth-entitlements-cache.json'

export type RetiredEntitlementCacheCleanup = { outcome: 'done' } | { outcome: 'failed'; message: string }

export async function removeRetiredEntitlementCache(userDataDir: string): Promise<RetiredEntitlementCacheCleanup> {
  try {
    // `force`: an absent file — every launch after the first — is not an error.
    await rm(join(userDataDir, RETIRED_ENTITLEMENT_CACHE_FILE_NAME), { force: true })
    return { outcome: 'done' }
  } catch (error) {
    return { outcome: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}
