import { TrackerProviderError } from '../../../shared/tracker/types';
// Registry-backed adapters for the write-back engine. The poster routes a post to
// the provider client registered for the proxy item's tracker and calls its
// capability-flagged postComment / transitionIssue; a provider that does not
// support the call rejects it, and the engine's failure isolation turns that into
// a visible notice rather than a silent no-op. The capability resolver exposes
// each provider's declared capabilities so the engine only ever attempts a post a
// provider actually supports.
export function createTrackerWriteBackPoster(registry) {
    return {
        async postComment({ provider, connectionId, externalId, body }) {
            await clientFor(registry, provider, connectionId).postComment({ connectionId, externalId, body });
        },
        async transitionIssue({ provider, connectionId, externalId, transitionId }) {
            await clientFor(registry, provider, connectionId).transitionIssue({ connectionId, externalId, transitionId });
        },
    };
}
export function createWriteBackCapabilityResolver(registry) {
    return {
        capabilitiesFor: (provider) => registry.get(provider)?.capabilities,
    };
}
function clientFor(registry, provider, connectionId) {
    const client = registry.get(provider);
    if (!client) {
        throw new TrackerProviderError('not_configured', 'No client available for this tracker.', { provider, connectionId });
    }
    return client;
}
