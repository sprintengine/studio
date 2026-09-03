// What is left of the tracker layer (MC-2363): the id→label table, kept because
// two unrelated surfaces still name a provider — the automations repo-event
// detail and the run board's provenance line.
//
// Multicode no longer integrates with ticket trackers; agents do, through the
// MCPs those companies ship. Everything else that lived here went with that
// decision. This file is a naming table, not an integration.

export type TrackerProviderId = 'github' | 'jira' | 'linear'

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
