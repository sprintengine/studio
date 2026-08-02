// Single source of truth for the first-party Multicode marketplace registry
// location (hotstacklabs/sprintengine-marketplace @ main). The registry client's
// raw.githubusercontent.com URL, the plugin downloader's GitHub contents API
// and source-pin check, and the verify-marketplace canonical source path all
// resolve their first-party scoping from this constant so the three former
// hardcodings cannot drift apart.

export type MarketplaceCanonicalSource = {
  owner: string
  repo: string
  ref: string
}

// Repointed 2026-08-02 from `multicode-labs/marketplace`, which never existed
// on GitHub — neither as a user nor an org — so the default registry URL had
// always resolved to nothing. MC-1671 flagged this as the same drift as the
// auto-update feed when the account moved to hotstacklabs, and asked for it to
// be checked at the same time; this is that check, landing late.
export const MARKETPLACE_CANONICAL_SOURCE: MarketplaceCanonicalSource = {
  owner: 'hotstacklabs',
  repo: 'sprintengine-marketplace',
  ref: 'main',
}
