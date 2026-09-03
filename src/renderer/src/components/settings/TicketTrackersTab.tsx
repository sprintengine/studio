import React from 'react'

import { TicketTrackerSection } from './TicketTrackerSection'

// Settings → Ticket trackers (MC-2363).
//
// The whole tab is now one thing: find your tracker and install its MCP, so
// your agents can work its tickets. Multicode itself no longer talks to
// trackers — the credential form, the connections list, the write-back settings
// and the in-app issue picker all went with the native layer, because browsing
// tickets here competes with the tracker's own UI and loses.
//
// It stays a named surface rather than four rows in the general MCP catalogue:
// "connect my issue tracker" is a thing people come looking for, and it should
// be findable without knowing it is an MCP.
export function TicketTrackersTab({ workspaceRoot }: { workspaceRoot: string | null }): JSX.Element {
  return (
    <div
      role="tabpanel"
      id="settings-panel-trackers"
      aria-labelledby="settings-tab-trackers"
      className="space-y-6"
    >
      <TicketTrackerSection workspaceRoot={workspaceRoot} />
    </div>
  )
}
