import { getConversationProviderById, getPluginById } from './plugin-registry-instance';
// Resolves a credential descriptor's owner by id across EVERY manifest kind that
// can declare `auth`: conversation providers and CLI plugins. This is what makes
// the credential store (src/main/secret-store.ts) a single shared mechanism
// rather than a chat-only one. Returns the owner (whose manifest may or may not
// declare auth) or undefined when no manifest with that id is installed.
//
// Ids are workspace-global and unique across kinds in practice; conversation
// providers are checked first so an existing chat provider keeps its descriptor.
export function resolveCredentialOwner(id) {
    return getConversationProviderById(id) ?? getPluginById(id) ?? undefined;
}
