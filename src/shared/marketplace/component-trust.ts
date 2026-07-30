// Security-critical trust primitives shared by the two defense-in-depth gates
// that decide whether a marketplace bundle may proceed: the download/stage path
// (src/main/marketplace/plugin-download.ts) and the installer preflight
// (src/main/modules/plugin-bundle-installer.ts). Both rules live here once so
// the enforcement points cannot silently drift — e.g. a future code-bearing
// kind must be added in a single place, not one gate only.

import {
  parseMarketplacePluginAuthoringManifest,
  parseMarketplacePluginManifest,
  type MarketplaceManifestIssue,
  type MarketplacePluginAuthoringManifest,
  type MarketplacePluginComponents,
} from './manifest'

// A code-bearing component executes arbitrary code once loaded (module or cli),
// so an unsigned bundle carrying one must never be permitted to proceed. MCP,
// skills, and automation components are declarative and may stage unsigned
// (load-ineligible). `automation` is declared declarative deliberately: an
// automation payload is a definition — a trigger, an action, and a prompt —
// interpreted by the app's own automation engine, never loaded as code.
export function hasCodeBearingComponent(components: MarketplacePluginComponents): boolean {
  return components.module !== undefined || components.cli !== undefined
}

export type OptionallySignedManifestResult =
  | { ok: true; manifest: MarketplacePluginAuthoringManifest }
  | { ok: false; issues: MarketplaceManifestIssue[] }

// Resolve a plugin.json under the optionally-signed contract: a signed manifest
// is validated strictly; a manifest whose only defect is a missing signature is
// accepted as unsigned so the kind-aware gate can decide whether to permit it;
// anything else (a present-but-malformed signature, structural errors) is
// rejected. Trust classification is layered on top by the download path, not
// decided here.
export function resolveOptionallySignedManifest(source: string): OptionallySignedManifestResult {
  const signed = parseMarketplacePluginManifest(source)
  if (signed.ok) return { ok: true, manifest: signed.manifest }
  const authoring = parseMarketplacePluginAuthoringManifest(source)
  if (authoring.ok && authoring.manifest.signature === undefined) {
    return { ok: true, manifest: authoring.manifest }
  }
  return { ok: false, issues: signed.issues }
}
