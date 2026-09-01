// The seam T3/T4/T5 register their clients through. Each provider client is a
// singleton keyed by its `provider` id; registering a second client for the same
// provider replaces the first (last wins), so a wiring reload is idempotent.
//
// T1 ships this registry EMPTY — with no client registered, the service degrades
// honestly ("no client available for this tracker yet") rather than faking a
// result. That keeps the zero-connection / no-provider path byte-identical to
// today until a real provider lands.
export class TrackerProviderRegistry {
    providers = new Map();
    register(provider) {
        this.providers.set(provider.provider, provider);
    }
    get(provider) {
        return this.providers.get(provider);
    }
    has(provider) {
        return this.providers.has(provider);
    }
}
// Process-wide registry shared by the tracker service and the provider clients.
let sharedRegistry = null;
export function getSharedTrackerProviderRegistry() {
    return (sharedRegistry ??= new TrackerProviderRegistry());
}
// Registration entry point the provider clients (T3/T4/T5) call at wiring time.
export function registerTrackerProvider(provider) {
    getSharedTrackerProviderRegistry().register(provider);
}
