// Canonical human display labels for tracker providers. Node-free single source
// consumed by the write-back settings copy, the "Started from" seed row, and the
// automations repo-event detail — each previously carried its own duplicate
// github/jira/linear → GitHub/Jira/Linear map. Provider-specific fallbacks (a
// neutral word, or the automations "Any source" pseudo-provider) stay with their
// caller; only the id→label table is shared.
import type { TrackerProviderId } from './types'

export const TRACKER_PROVIDER_LABEL: Record<TrackerProviderId, string> = {
  github: 'GitHub',
  jira: 'Jira',
  linear: 'Linear',
}

// Falls back to a neutral word so an unknown/absent provider still reads plainly.
export function trackerProviderLabel(provider: TrackerProviderId | string | null | undefined): string {
  if (typeof provider === 'string' && provider in TRACKER_PROVIDER_LABEL) {
    return TRACKER_PROVIDER_LABEL[provider as TrackerProviderId]
  }
  return 'the tracker'
}
