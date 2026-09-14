// Single source of truth for the first-party studio marketplace registry
// location: the public `sprintengine/studio-releases` repository, which also
// carries the app's releases and the hosted model feed. The registry client's
// raw.githubusercontent.com URL, the plugin downloader's GitHub contents API
// and source-pin check, and the verify-marketplace canonical source path all
// resolve their first-party scoping from this constant so the three former
// hardcodings cannot drift apart.

export type MarketplaceCanonicalSource = {
  owner: string
  repo: string
  ref: string
}

// Repointed 2026-09-05 (backlog/2026-09-05-plugin-sources.md, "Hosting") from a
// private-org marketplace repository that redirects to an EMPTY public
// repository — the registry read is bundled-first, so nobody noticed. The
// releases repo is already public, already fetched hourly for the model feed,
// and already edited by pull request; one catalogue lives there now.
export const MARKETPLACE_CANONICAL_SOURCE: MarketplaceCanonicalSource = {
  owner: 'sprintengine',
  repo: 'studio-releases',
  ref: 'main',
}
