import React, { useCallback, useMemo, useState } from 'react'

import { addThirdPartyModuleFromFolder } from '../settings/addThirdPartyModuleFromFolder'
import { FolderPlusIcon } from '../AppIcons'
import { ActionResultMessage, Spinner } from '../ui'
import type { ActionResult } from '../ui'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useExtensionsDrawerRows } from './extensionsDrawerRows'
import { SidebarNavButton } from './SidebarNavButton'
import { useExtensionsRowBadges } from './useExtensionsRowBadges'

// The Extensions drawer (app shell, 2026-09-05): the sidebar column
// while the app rail's Extensions glyph is chosen. Everything a person can open
// that is not a chat and is not one of the product's own standing tools — the
// things ADDED to the product — in one column with one row chrome.
//
// The product rows and their order are the ruling, held as data next door
// (`extensionsDrawer.ts`); installed module doors follow them. Resolving both
// shapes against the live registry — what each row is called, what it looks
// like and what clicking it does — is `extensionsDrawerRows.ts`, shared with
// the Extensions home's tiles so the two cannot route differently (Stage 3).
// This file is only the column's chrome.
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
// Each row wears its own unread count (owner, 2026-09-08): the news that
// belongs to it, and for a run door the runs waiting on an answer. The drawer
// only wears them — `useExtensionsRowBadges` derives them, and the same
// derivation is what the app rail's Extensions square sums, so the square and
// the rows beneath it never disagree. A row's count clears when its page is
// on screen (`useRailBadges` does the reading), which is what makes the count
// an answer to "where did that come from?" rather than a number that vanishes
// the moment the drawer opens.
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
  const badges = useExtensionsRowBadges()
  const openSettingsOverlay = useWorkspaceStore((state) => state.openSettingsOverlay)
  const [installing, setInstalling] = useState(false)
  const [installMessage, setInstallMessage] = useState<ActionResult | null>(null)

  const addExtension = useCallback(async () => {
    if (installing) return
    setInstalling(true)
    setInstallMessage(null)
    try {
      const result = await addThirdPartyModuleFromFolder(window.api)
      if (result.status === 'failed') {
        setInstallMessage({ tone: 'error', text: result.message })
      } else if (result.status === 'installed') {
        // Installation never grants trust. Land on the existing review surface,
        // where requested access, signature state, trust, and enablement are all
        // shown together instead of reimplementing that security decision here.
        openSettingsOverlay({ initialTab: 'modules' })
      }
    } finally {
      setInstalling(false)
    }
  }, [installing, openSettingsOverlay])

  const rows = useMemo(
    () =>
      drawerRows.flatMap((row) => {
        const badge = row.rowId ? badges[row.rowId] : undefined
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
                  <RowComponent collapsed={collapsed} badge={badge} />
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
                badge={badge}
                onClick={row.open}
              />
            ),
          },
        ]
      }),
    [collapsed, drawerRows, badges],
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-[color:var(--border-subtle)] px-2 pb-2 pt-2">
        <SidebarNavButton
          collapsed={collapsed}
          variant="dashed"
          icon={
            installing
              ? <Spinner className="icon-sm shrink-0" />
              : <FolderPlusIcon className="icon-sm pointer-events-none shrink-0" />
          }
          label={installing ? 'Adding extension…' : 'Add extension'}
          ariaLabel={installing ? 'Adding extension from a folder' : 'Add extension from a folder'}
          tooltip={installMessage?.text ?? (installing ? 'Adding extension from a folder' : 'Add extension from a folder')}
          disabled={installing}
          onClick={() => void addExtension()}
        />
        {!collapsed ? <ActionResultMessage message={installMessage} className="mt-2" /> : null}
      </div>
      <div role="list" aria-label="Extensions" className="mx-2 mt-1 flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
        {rows.map((row) => (
          <div key={row.key} role="listitem" className="flex flex-col">
            {row.node}
          </div>
        ))}
      </div>
    </div>
  )
}
