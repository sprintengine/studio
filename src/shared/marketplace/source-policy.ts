// Marketplace bundle source policy shared by the app downloader
// (src/main/marketplace/plugin-download.ts) and the registry CI verifier
// (resources/marketplace/verify-marketplace.ts). Both enforce the same
// HTTPS + host-allowlist rule so a registry entry the CLI accepts is exactly
// the set of hosts the app will fetch from, bounding SSRF/abuse: an entry
// source URL and every followed per-file download_url must resolve to an
// allowlisted host. The allowlist replaces the earlier single-canonical-repo
// pin; first-party scoping (packaged-seed staging) is handled separately via
// MARKETPLACE_CANONICAL_SOURCE.

// GitHub is the only supported bundle host today: the entry source lives on
// github.com, the Contents API on api.github.com, and per-file download_url
// values on raw.githubusercontent.com. All three must be allowlisted or the
// download stalls mid-tree.
const MARKETPLACE_ALLOWED_SOURCE_HOSTS: readonly string[] = [
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
]

// Comma-separated extra hosts to extend the allowlist (default empty). Read by
// each consumer from its own environment and passed in — this module stays free
// of runtime/host coupling.
export const MARKETPLACE_EXTRA_HOSTS_ENV = 'SPRINTENGINE_MARKETPLACE_EXTRA_HOSTS'

// Parse the extra-host allowlist extension. Hostnames only, lowercased; blank,
// wildcard, and path-bearing tokens are dropped so the list can never widen to
// "any URL".
export function parseMarketplaceExtraHosts(raw: string | null | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0 && !token.includes('*') && !token.includes('/'))
}

export function isMarketplaceSourceHostAllowed(hostname: string, extraHosts: readonly string[] = []): boolean {
  const host = hostname.toLowerCase()
  return MARKETPLACE_ALLOWED_SOURCE_HOSTS.includes(host) || extraHosts.includes(host)
}
