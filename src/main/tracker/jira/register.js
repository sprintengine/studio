import { JiraTrackerProvider } from './jira-provider';
import { registerTrackerProvider } from '../provider-registry';
import { getSharedTrackerService } from '../tracker-service';
// Wires the Jira provider into the shared tracker registry (MC-1635). Called once
// at main-process bootstrap (mirrors registerLinearTrackerProvider). ONE client
// serves Jira Cloud and Data Center — the client resolves credentials +
// connection metadata through the shared service's connection store (the same
// store the IPC surface persists connections into), branching only on the auth
// header, so a Jira connection the user adds (Cloud or self-hosted) is
// immediately usable and its capabilities drive the settings form without a
// provider `if`. Registering again replaces the prior client (last wins), so a
// wiring reload is idempotent.
export function registerJiraTrackerProvider(service = getSharedTrackerService()) {
    registerTrackerProvider(new JiraTrackerProvider({ connections: service.connections }));
}
