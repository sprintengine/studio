// storefrontView — pure, DOM-free helpers for the marketplace plugin surfaces
// (`BrowseStorefront.tsx`, the Connectors inventory).

import type { MarketplaceComponentKind } from '../../../../shared/marketplace/manifest'

// Sentence-case labels for the component kinds a plugin bundles. Mirrors the
// installed-inventory kind labels so the same primitive reads the same way on
// both surfaces.
const COMPONENT_KIND_LABEL: Record<MarketplaceComponentKind, string> = {
  mcp: 'MCP server',
  skills: 'Skill pack',
  module: 'Module',
  cli: 'Agent CLI',
  automation: 'Automation',
}

export function componentKindLabels(provides: MarketplaceComponentKind[]): string[] {
  return provides.map((kind) => COMPONENT_KIND_LABEL[kind])
}

// Render-boundary guard for the "View source" affordance. A plugin `source` is
// only schema-checked as a non-empty string (manifest.ts), so once a third-party
// or catalogue registry is in play the value is attacker-influenced. The detail
// panel opens it via an external anchor that routes to shell.openExternal, and
// only http(s) is safe to hand there — a `file://`, `smb://`, or OS
// protocol-handler URL is a known Electron abuse vector. Return the value only
// when it parses to an http/https URL; otherwise fail closed to `undefined` so
// the component renders no link. Mirrors the fetch path's scheme distrust but
// intentionally omits the host allowlist: this is a display-only link.
export function externalSourceHref(source: string | undefined): string | undefined {
  if (!source) return undefined
  let url: URL
  try {
    url = new URL(source)
  } catch {
    return undefined
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? source : undefined
}
