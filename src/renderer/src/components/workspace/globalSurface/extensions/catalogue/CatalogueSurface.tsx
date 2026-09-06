// The one shape the three Extensions catalogues share.
//
// Source-tabs ruling (2026-09-05): Plugins, Skills and Agent CLIs are the same
// page three times — the view's name and a search field on the chrome row,
// Installed and then one tab per source under it with a plus at the end, and
// inside the open tab the connector row idiom in two columns, kept in its
// groups, walked by one pager. The nested Sources rail is gone: the drawer and
// this row are the whole navigation, so the door brings no rail and the
// sidebar column keeps the five drawer rows the person arrived by.
//
// This file owns that frame. What goes IN a tab is each catalogue's own
// business — a registry category, a repository's folders, the CLI shelf — and
// arrives as sections of items plus a way to draw one.

import React, { useMemo, useState } from 'react'

import {
  InboxSearchInput,
  OverflowMenu,
  Pager,
  Tabs,
  TabPanel,
  Tooltip,
  type TabItem,
} from '../../../../ui'
import { FOCUS_RING_CLASS } from '../../../../ui/tokens'
import { ConnectorSectionHeading } from '../../../../panels/ConnectorsPanel/ConnectorRow'
import { GlobalSurfaceShell } from '../../GlobalSurfaceShell'
import { useSurfaceBackNav } from '../../surfaceBackNav'
import {
  CATALOGUE_PAGE_SIZE,
  deriveCataloguePage,
  stepCataloguePage,
  type CatalogueGroup,
} from './cataloguePaging'
import { INSTALLED_TAB_ID, type CatalogueTab } from './catalogueTabs'

const TABS_PREFIX = 'extensions-catalogue'

/** One group inside the open tab: a heading, and the rows it holds in order. */
export type CatalogueSection<T> = {
  key: string
  label: string
  items: readonly T[]
}

/** The two ways a source gets added, from the plus after the last tab. */
export type CatalogueAddMenu = {
  onAddFromFile: () => void
  onAddFromGitHub: () => void
}

export function CatalogueSurface<T>({
  title,
  tabs,
  activeTabId,
  onSelectTab,
  search,
  add,
  head,
  notices,
  body,
  sections,
  renderRow,
  noun,
  detail,
}: {
  /** The view's name: "Plugins", "Skills", "Agent CLIs". */
  title: string
  tabs: readonly CatalogueTab[]
  activeTabId: string
  onSelectTab: (tabId: string) => void
  search: { query: string; onQueryChange: (value: string) => void; placeholder: string }
  /** Null hides the plus — a kind no source can carry (see catalogueTabs). */
  add: CatalogueAddMenu | null
  /** The head line under the tab row: what this tab is, and its actions. */
  head?: React.ReactNode
  notices?: React.ReactNode
  /**
   * Rendered INSTEAD of the paged sections, for a state that is not a list:
   * loading, unreadable, nothing here yet.
   */
  body?: React.ReactNode
  sections?: readonly CatalogueSection<T>[]
  renderRow?: (item: T, index: number) => React.ReactNode
  /** Singular noun for the pager's sentence: 'plugin', 'skill', 'agent CLI'. */
  noun: string
  /** The detail pane beside the list; the row click opens it, as before. */
  detail?: React.ReactNode
}): JSX.Element {
  const back = useSurfaceBackNav()
  // The page a person is standing on, and what it is a page OF. Changing tab
  // or typing in the search box lands on page 1 — the alternative is page 9 of
  // a two-page result, which the model then clamps, so the person's click on
  // "9" silently becomes something else.
  const positionKey = `${activeTabId} ${search.query.trim()}`
  const [position, setPosition] = useState({ key: positionKey, page: 1 })
  const current = stepCataloguePage(position, positionKey)

  const groups = useMemo<CatalogueGroup[]>(
    () =>
      (sections ?? []).map((section) => ({
        key: section.key,
        label: section.label,
        count: section.items.length,
      })),
    [sections],
  )
  const view = deriveCataloguePage({
    groups,
    page: current.page,
    pageSize: CATALOGUE_PAGE_SIZE,
    query: search.query,
    noun,
  })
  const sectionByKey = useMemo(
    () => new Map((sections ?? []).map((section) => [section.key, section])),
    [sections],
  )

  const items: TabItem[] = tabs.map((tab) => ({
    id: tab.id,
    label: tab.label,
    // A count that is not known is absent, never zero: a scan still reading,
    // or one that failed, must not render as an empty source.
    count: tab.count ?? undefined,
    // The hourly check saw this source's repository move past the commit its
    // scan was taken at. The mark rides the tab so it is visible without
    // opening the source, and the glyph is decorative — the tab's name carries
    // the words, and Sync on the head line is where it is acted on.
    icon: tab.updateAvailable ? <UpdateMark /> : undefined,
    ariaLabel: tab.updateAvailable ? `${tab.label} — update available` : undefined,
  }))

  const bar = {
    title,
    actions: (
      <div className="w-[260px]">
        <InboxSearchInput
          value={search.query}
          onChange={(value) => {
            search.onQueryChange(value)
            setPosition({ key: `${activeTabId} ${value.trim()}`, page: 1 })
          }}
          ariaLabel={`Search ${title.toLowerCase()} in the open tab`}
          placeholder={search.placeholder}
          controlsId={`${TABS_PREFIX}-panel-${activeTabId}`}
        />
      </div>
    ),
  }

  const activeTabLabel = tabs.find((tab) => tab.id === activeTabId)?.label ?? 'this tab'

  return (
    <GlobalSurfaceShell ariaLabel={title} bar={bar} onBack={back.onBack} canGoBack={back.canGoBack}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-end gap-1 border-b border-[color:var(--border-default)] px-5">
          <Tabs
            ariaLabel={`${title} sources`}
            idPrefix={TABS_PREFIX}
            items={items}
            value={activeTabId}
            onChange={(id) => {
              onSelectTab(id)
              setPosition({ key: `${id} ${search.query.trim()}`, page: 1 })
            }}
            borderless
            // Not `flex-1`: the plus belongs directly after the last tab (the
            // ruling), and a strip that grows to fill the band would park it at
            // the far edge with a gulf of nothing between. It still shrinks and
            // scrolls when the sources outgrow the row.
            className="min-w-0 overflow-x-auto"
          />
          {add ? <AddSourceMenu add={add} /> : null}
        </div>

        <div className="flex min-h-0 flex-1">
          <TabPanel
            idPrefix={TABS_PREFIX}
            tabId={activeTabId}
            active
            className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-4"
          >
            {head ? <div className="mb-4">{head}</div> : null}
            {notices ? <div className="mb-3 space-y-2">{notices}</div> : null}
            {body ?? (
              <>
                <div className="space-y-5">
                  {view.groups.map((group) => {
                    const section = sectionByKey.get(group.key)
                    if (!section || !renderRow) return null
                    return (
                      <section key={group.key} className="space-y-2">
                        <ConnectorSectionHeading
                          // A group that started on an earlier page says so,
                          // rather than repeating its heading as if the rows
                          // above it were something else.
                          label={group.continued ? `${group.label} (continued)` : group.label}
                          count={group.total}
                        />
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          {section.items
                            .slice(group.start, group.end)
                            .map((item, index) => renderRow(item, group.start + index))}
                        </div>
                      </section>
                    )
                  })}
                </div>
                <Pager
                  page={view.page}
                  pageCount={view.pageCount}
                  rangeLabel={view.rangeLabel}
                  onPageChange={(page) => setPosition({ key: positionKey, page })}
                  ariaLabel={`${title} in ${activeTabLabel}`}
                />
              </>
            )}
          </TabPanel>
          {detail}
        </div>
      </div>
    </GlobalSurfaceShell>
  )
}

/** An upward step: this source has moved on since it was last read. */
function UpdateMark(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
      <circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 10.6V5.4M5.8 7.4 8 5.2l2.2 2.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * The plus after the last tab. Two ways in and no more: a folder on this
 * machine, or a repository on GitHub. It is the kit's overflow menu wearing a
 * plus rather than a kebab, so Enter opens it, the arrows rove and Escape
 * closes it without this file writing a menu of its own.
 */
function AddSourceMenu({ add }: { add: CatalogueAddMenu }): JSX.Element {
  return (
    <OverflowMenu
      ariaLabel="Add source"
      align="end"
      items={[
        { id: 'file', label: 'Add from file…', onSelect: add.onAddFromFile },
        { id: 'github', label: 'Add from GitHub…', onSelect: add.onAddFromGitHub },
      ]}
      trigger={(open, opened) => (
        <Tooltip content="Add source" placement="bottom">
          <button
            type="button"
            aria-label="Add source"
            aria-expanded={opened}
            aria-haspopup="menu"
            onClick={open}
            className={`mb-1 inline-flex size-icon-lg shrink-0 items-center justify-center rounded-md text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
          >
            <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
              <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </Tooltip>
      )}
    />
  )
}

/**
 * The head line under the tab row: the source's own state on the left, its
 * actions on the right. Sync, Open on GitHub and Remove lived on the Sources
 * rail's source page; they are here now, in one place per tab, rather than on
 * the tab itself where they would be three controls inside a navigation.
 */
export function CatalogueHead({
  monogram,
  name,
  stateLine,
  actions,
}: {
  monogram?: React.ReactNode
  name: string
  stateLine: React.ReactNode
  actions?: React.ReactNode
}): JSX.Element {
  return (
    <div className="flex items-start gap-2.5">
      {monogram}
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-body font-semibold text-[color:var(--text-strong)]">{name}</h3>
        <p className="mt-0.5 max-w-[74ch] text-meta text-[color:var(--text-muted)]">{stateLine}</p>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </div>
  )
}

export { INSTALLED_TAB_ID }
