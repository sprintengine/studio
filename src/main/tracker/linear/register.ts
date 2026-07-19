import { registerTrackerProvider } from '../provider-registry'
import { getSharedTrackerService, type TrackerService } from '../tracker-service'
import { LinearTrackerProvider } from './linear-provider'

// Wires the Linear provider into the shared tracker registry (MC-1636). Called
// once at main-process bootstrap. The provider resolves credentials and
// connection metadata through the shared service's connection store — the same
// store the IPC surface persists connections into — so a Linear connection the
// user adds is immediately usable, and its capabilities drive T2's form without a
// provider `if`. Registering again replaces the prior client (last wins), so a
// wiring reload is idempotent.
export function registerLinearTrackerProvider(service: TrackerService = getSharedTrackerService()): void {
  registerTrackerProvider(new LinearTrackerProvider({ connections: service.connections }))
}
