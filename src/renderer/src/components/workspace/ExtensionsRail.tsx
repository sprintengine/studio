import React, { useMemo } from 'react'

import { useExtensionsDrawerRows } from './extensionsDrawerRows'
import { SidebarNavButton } from './SidebarNavButton'

// The Extensions drawer (app shell, 2026-09-05): the sidebar column
// while the app rail's Extensions glyph is chosen. Everything a person can open
// that is not a chat and is not one of the product's own standing tools — the
// things ADDED to the product — in one column with one row chrome.
//
// The rows and their order are the ruling, held as data next door
// (`extensionsDrawer.ts`), and resolving them against the live registry —
// what each row is called, what it looks like and what clicking it does — is
// `extensionsDrawerRows.ts`, shared with the Extensions home's tiles so the two
// cannot route differently (Stage 3). This file is only the column's chrome.
//
// A row whose module is disabled simply is not there: every lookup goes through
// the host's enablement filter, and a miss renders nothing rather than a dead
// row.
//
// The drawer STAYS PUT while the card region swaps — that is what makes it the
// navigation rather than a menu (Stage 2 of the ruling). Its rows open DOORS
// now, not modals, and a door that is a drawer row declares `railPlacement:
// 'inline'` so it renders its own rail beside its canvas instead of taking this
// column. Only Sprints, whose rail is its own list of runs, still replaces this
// column for the length of its visit, and the host's back chevron or a rail
// glyph brings the drawer back.
//
// No heading and no groups: a heading must separate something from something
// else (principles, Composition), and to the person these are all just
// extensions.

type ExtensionsRailProps = {
  collapsed: boolean
}

export function ExtensionsRail({ collapsed }: ExtensionsRailProps) {
  // The rows resolve themselves, nav entries included: the sidebar's own memo
  // is keyed on module enablement alone and misses a third-party module that
  // registers late, which put a row on the Extensions home and not here.
  const drawerRows = useExtensionsDrawerRows()

  const rows = useMemo(
    () =>
      drawerRows.flatMap((row) => {
        // A module's own row component owns its full chrome — a status dot, its
        // own wider reading of "selected" — so it renders instead of a generic
        // row, not beside one.
        if (row.navComponent) {
          const RowComponent = row.navComponent
          return [
            {
              key: row.key,
              node: (
                <React.Suspense fallback={null}>
                  <RowComponent collapsed={collapsed} />
                </React.Suspense>
              ),
            },
          ]
        }
        // A door with neither a name nor a glyph cannot be drawn as a generic
        // row, and there is nothing else here to draw it with.
        if (!row.label || !row.Icon) return []
        const { Icon } = row
        return [
          {
            key: row.key,
            node: (
              <SidebarNavButton
                collapsed={collapsed}
                icon={<Icon className="icon-sm pointer-events-none shrink-0" />}
                label={row.label}
                ariaLabel={row.label}
                tooltip={row.label}
                active={row.active}
                onClick={row.open}
              />
            ),
          },
        ]
      }),
    [collapsed, drawerRows],
  )

  return (
    // `aria-current`, not `aria-pressed`, on the selected row (SidebarNavButton's
    // `active`). These rows are NAVIGATION — each routes the card region to a
    // different page, and the lit one says where you are, exactly as the
    // workspaces tree's rows do. The app rail's Automations square is the other
    // reading on purpose: the rail is a fixed strip of chrome rather than a list
    // a person walks, and its square stays PRESSED while the tool it holds is up
    // (principles, "The app rail"). Same state, two honest readings; what would
    // be wrong is one row of this column disagreeing with the row above it.
    <div role="list" aria-label="Extensions" className="mx-2 mt-1 flex flex-col gap-1.5">
      {rows.map((row) => (
        <div key={row.key} role="listitem" className="flex flex-col">
          {row.node}
        </div>
      ))}
    </div>
  )
}
