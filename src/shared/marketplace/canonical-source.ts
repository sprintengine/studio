// Single source of truth for the first-party Multicode marketplace registry
// location (multicode-labs/marketplace @ main). The registry client's
// raw.githubusercontent.com URL, the plugin downloader's GitHub contents API
// and source-pin check, and the verify-marketplace canonical source path all
// resolve their first-party scoping from this constant so the three former
// hardcodings cannot drift apart.

export type MarketplaceCanonicalSource = {
  owner: string
  repo: string
  ref: string
}

export const MARKETPLACE_CANONICAL_SOURCE: MarketplaceCanonicalSource = {
  owner: 'multicode-labs',
  repo: 'marketplace',
  ref: 'main',
}
