import { registerTrackerProvider } from '../provider-registry';
import { getSharedTrackerService } from '../tracker-service';
import { GitHubTrackerProvider } from './client';
// Wires the GitHub provider into the shared tracker registry (MC-1634). Called
// once at main-process bootstrap (mirrors registerLinearTrackerProvider). The
// client resolves credentials + connection metadata through the shared service's
// connection store — the same store the IPC surface persists connections into —
// so a GitHub connection the user adds (github.com or GHES) is immediately usable
// and its capabilities drive the settings form without a provider `if`.
// Registering again replaces the prior client (last wins), so a reload is idempotent.
export function registerGitHubTrackerProvider(service = getSharedTrackerService()) {
    registerTrackerProvider(new GitHubTrackerProvider({ connections: service.connections }));
}
