import React from 'react'

import { EmptyState } from '../ui/EmptyState'
import { GlobalSurfaceShell } from '../workspace/globalSurface/GlobalSurfaceShell'
import { useSurfaceBackNav } from '../workspace/globalSurface/surfaceBackNav'
import { ExtensionsGlyph } from '../workspace/AppRail'

// The Extensions home (the app rail's Extensions glyph, 2026-09-05): the page
// the glyph opens, in the card region, with the Extensions drawer standing
// beside it as the navigation.
//
// A DOOR, not a modal (Extensions drawer ruling, 2026-09-05, Stage 2). It was
// the `marketplace` modal for a few hours on the same day; the modal floated
// over the card region with a scrim, which put a dialog between the person and
// the drawer they had just used. Its id changed with its shape — `marketplace`
// named a browse that does not exist yet, `extensions-home` names the page.
//
// Core, like Settings: this is where the product's own parts are offered, so no
// module may gate it (renderer-host reserves the id; WorkspaceManager resolves
// it from the app itself).
//
// **The body is a placeholder and says so.** Stage 3 of the ruling builds the
// real home — five tiles (Sprints, Design, Plugins, Skills, Agent CLIs) with a
// live count each, opening the same surfaces the drawer rows do. What this page
// deliberately does NOT carry any more is the module list: module switches live
// in Settings → Modules, and having them here too put the same choice in two
// shapes on two surfaces (principles, Composition).
export default function ExtensionsHomeSurface(): JSX.Element {
  const back = useSurfaceBackNav()
  return (
    <GlobalSurfaceShell
      ariaLabel="Extensions"
      // The door's name rides the app's one top strip, where the workspace name
      // would be — a surface owns its whole region including its top row.
      bar={{ title: 'Extensions' }}
      onBack={back.onBack}
      canGoBack={back.canGoBack}
    >
      <div className="flex h-full min-h-0 flex-col gap-6 overflow-y-auto px-5 py-4">
        <section aria-labelledby="extensions-community-heading" className="space-y-2">
          <h2
            id="extensions-community-heading"
            className="text-heading font-semibold text-[color:var(--text-strong)]"
          >
            Community
          </h2>
          <EmptyState
            density="list"
            glyph={<ExtensionsGlyph className="icon-lg" />}
            title="Coming soon"
            body="Extensions built by the community — a browse of modules other people have published, with search and one-click install, will be listed here once the registry scan lands."
          />
        </section>
      </div>
    </GlobalSurfaceShell>
  )
}
