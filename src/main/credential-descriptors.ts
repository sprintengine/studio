import type { ManifestAuth } from '../shared/plugin-manifest'
import { getConversationProviderById, getPluginById } from './plugin-registry-instance'

// A manifest that may declare a credential. Structurally shared by both
// LoadedConversationProvider and LoadedPlugin (CLI), so the credential store can
// resolve either without knowing which kind it is.
export type CredentialOwner = { manifest: { auth?: ManifestAuth } }

// Resolves a credential descriptor's owner by id across EVERY manifest kind that
// can declare `auth`: conversation providers and CLI plugins. This is what makes
// the credential store (src/main/secret-store.ts) a single shared mechanism
// rather than a chat-only one. Returns the owner (whose manifest may or may not
// declare auth) or undefined when no manifest with that id is installed.
//
// Ids are workspace-global and unique across kinds in practice; conversation
// providers are checked first so an existing chat provider keeps its descriptor.
export function resolveCredentialOwner(id: string): CredentialOwner | undefined {
  return getConversationProviderById(id) ?? getPluginById(id) ?? undefined
}
