import type { MarketplacePluginAuthoringManifest, MarketplacePluginComponents } from '../../shared/marketplace'
import { MARKETPLACE_COMPONENT_KINDS } from '../../shared/marketplace'
import { computeMarketplacePluginComponentsWithDigestsSync } from '../../../packages/module-sdk/src/plugin-component-digests'

// The component digests an UNSIGNED plugin.json is held to.
//
// A signed plugin.json lists a digest per component file and the signature
// covers them, so the bytes are the publisher's. An unsigned one vouches for
// nothing whether or not it lists digests — anybody can write them — and an
// author who never signs has no tool that writes them. What holds an unsigned
// install to what the person reviewed is the trust pin (a digest of every
// staged file, re-checked at install), and for a module its own `files` map.
// So a component an unsigned manifest lists no digests for is held to the
// bytes that were read, which still refuses what a bundle may never carry
// (a key file, node_modules, a path that is not there); a component it does
// list digests for is held to them, as before.
export function withObservedUnsignedDigests<
  T extends Pick<MarketplacePluginAuthoringManifest, 'components'> & {
    signature?: unknown
  },
>(bundleRoot: string, manifest: T): T {
  if (manifest.signature !== undefined) return manifest
  const undigested: MarketplacePluginComponents = {}
  for (const kind of MARKETPLACE_COMPONENT_KINDS) {
    const component = manifest.components[kind]
    if (component && !component.files) undigested[kind] = component
  }
  if (Object.keys(undigested).length === 0) return manifest
  const observed = computeMarketplacePluginComponentsWithDigestsSync(bundleRoot, undigested)
  // A walk that found something it cannot digest leaves the component as it
  // was, so the mismatch check that follows reports the reason in its words.
  if (!observed.ok) return manifest
  return { ...manifest, components: { ...manifest.components, ...observed.components } }
}
