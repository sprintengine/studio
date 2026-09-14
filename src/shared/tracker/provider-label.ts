// What is left of the tracker layer (MC-2363): the id→label table, kept because
// two unrelated surfaces still name a provider — the automations repo-event
// detail and the run board's provenance line.
//
// The studio no longer integrates with ticket trackers; agents do, through the
// MCPs those companies ship. Everything else that lived here went with that
// decision. This file is a naming table, not an integration.

export type TrackerProviderId = 'github' | 'jira' | 'linear'

export const TRACKER_PROVIDER_LABEL: Record<TrackerProviderId, string> = {
  github: 'GitHub',
  jira: 'Jira',
  linear: 'Linear',
}
