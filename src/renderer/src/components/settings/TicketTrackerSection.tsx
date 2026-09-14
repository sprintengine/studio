import React from 'react'

import { EmptyState, GhostButton } from '../ui'
import { useWorkspaceStore } from '../../store/workspaceStore'

// Settings → Ticket trackers (MC-2362, narrowed by MC-2363, emptied by MC-2519).
//
// "Connect my ticket tracker to my agents" is answered by installing that
// tracker's MCP, so an agent can read and update tickets during a run. That is
// the whole integration: the studio itself does not talk to trackers, because
// browsing tickets in an IDE competes with the tracker's own UI and loses.
//
// This pane used to list the trackers itself, from rows in the bundled MCP
// catalogue marked `ticketTracker: true` — membership was catalogue data so
// that adding a fifth tracker was a data edit rather than a renderer change.
// Both halves of that are gone. The frozen-snapshots retirement (2026-09-06)
// removed the four tracker rows, because Jira/Confluence, Linear, GitHub and
// GitLab are all plugins in `anthropics/claude-plugins-official` and nobody
// should be offered two routes to one server; the third-party retirement
// (MC-2519, 2026-09-08) removed the catalogue itself. There is no longer a list
// of trackers this build holds, and adding a fifth is not an edit anywhere in
// this repository: it is a plugin somebody publishes to a source.
//
// So the pane says the one true thing it can and hands over to the surface that
// can act on it. It renders no bands and reads no source, rather than reading a
// source that can only ever answer with nothing.
export function TicketTrackerSection(): JSX.Element {
  const openExtensionsSurface = useWorkspaceStore((s) => s.openExtensionsSurface)
  return (
    <section className="space-y-3">
      <EmptyState
        density="list"
        title="Trackers are plugins."
        body="Jira, Linear, GitHub and GitLab install from the plugin catalogue."
        action={
          <GhostButton
            size="md"
            onClick={() => openExtensionsSurface({ view: 'plugins' })}
            className="h-control-md"
          >
            Browse plugins
          </GhostButton>
        }
      />
    </section>
  )
}
