import React from 'react'

import { ModulesSettingsTab } from '../settings/ModulesSettingsTab'
import { EmptyState } from '../ui/EmptyState'
import { ExtensionsGlyph } from '../workspace/AppRail'

// The Extensions marketplace (the app rail's Extensions glyph, 2026-09-05):
// one place for what extends the product — what can be installed, and what
// is. Slack's Apps page is the model: a browse of the community's offerings
// above the list of what this workspace already has.
//
// The browse half is a promise today. The registry scan that lists community
// modules (backlog: extensions-marketplace-scans-the-community) is not built,
// so the section says so plainly instead of drawing an empty grid, and the
// installed half is the module manager Settings → Modules already renders —
// the same component, so the two never drift. When the scan lands it takes
// the browse section's place and nothing below it moves.
//
// Core, like Settings: this is where modules are turned on and off, so no
// module may gate it (WorkspaceManager, CORE_MARKETPLACE_MODAL_SURFACE).
export default function ExtensionsMarketplaceSurface(): JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col gap-6 overflow-y-auto px-6 py-5">
      <section aria-labelledby="extensions-browse-heading" className="space-y-2">
        <h2 id="extensions-browse-heading" className="text-heading font-semibold text-[color:var(--text-strong)]">
          Browse
        </h2>
        <EmptyState
          density="list"
          glyph={<ExtensionsGlyph className="icon-lg" />}
          title="Community extensions"
          body="Extensions built by the community will be listed here once the registry scan lands. Everything installed on this machine is below."
        />
      </section>
      <section aria-labelledby="extensions-installed-heading" className="space-y-2">
        <h2 id="extensions-installed-heading" className="text-heading font-semibold text-[color:var(--text-strong)]">
          Installed
        </h2>
        <ModulesSettingsTab />
      </section>
    </div>
  )
}
