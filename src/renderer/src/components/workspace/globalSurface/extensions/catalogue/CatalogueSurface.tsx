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
// List-card ruling (2026-09-15): each group's rows sit in the settings list
// card — one bordered surface per group, the rows full-bleed inside it, two
// abreast — the same card the Remote tab's machines and the Settings lists
// sit in. The rows were a gap grid before, and a page of them read as a
// different product from the Settings page one door over.
//
// This file owns that frame. What goes IN a tab is each catalogue's own
// business — a registry category, a repository's folders, the CLI shelf — and
// arrives as sections of items plus a way to draw one and a way to key it.

import React, { useMemo, useState } from 'react'

import {
  IconButton,
  InboxSearchInput,
  OverflowMenu,
  Pager,
  SettingCard,
  Tabs,
  TabPanel,
  Tooltip,
  type TabItem,
} from '../../../../ui'
import { ConnectorSectionHeading } from '../../../../panels/ConnectorsPanel/ConnectorRow'
import { GlobalSurfaceShell } from '../../GlobalSurfaceShell'
import { useSurfaceBackNav } from '../../surfaceBackNav'
import { ADD_LOCAL_SKILL_SOURCE_LABEL } from '../../../../../../../shared/skills'
import {
  CATALOGUE_PAGE_SIZE,
  deriveCataloguePage,
  stepCataloguePage,
  type CatalogueGroup,
} from './cataloguePaging'
import { type CatalogueTab } from './catalogueTabs'

const TABS_PREFIX = 'extensions-catalogue'

/** One group inside the open tab: a heading, and the rows it holds in order. */
export type CatalogueSection<T> = {
  key: string
  label: string
  items: readonly T[]
  /**
   * A mark before the heading — the source's avatar, when the sections are
   * sources rather than a source's folders (a cross-source search). Absent for
   * the ordinary tab, whose head already wears the one source's mark.
   */
  leading?: React.ReactNode
}

/**
 * What the search box reads: `tab` filters the open tab and says so; `sources`
 * reads every source the door holds a scan for (catalogueSearch.ts), and the
 * field and the pager name that scope instead of the tab.
 */
export type CatalogueSearchScope = 'tab' | 'sources'

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
  rowKey,
  noun,
  detail,
}: {
  /** The view's name: "Plugins", "Skills", "Agent CLIs". */
  title: string
  tabs: readonly CatalogueTab[]
  activeTabId: string
  onSelectTab: (tabId: string) => void
  search: {
    query: string
    onQueryChange: (value: string) => void
    placeholder: string
    /** Defaults to `tab`. */
    scope?: CatalogueSearchScope
  }
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
  /**
   * Draws one item, already in its `<li>`: the surface owns the list item, so
   * a row component need not know it is in a list, and the card's hairline
   * math counts one child per item. `rowKey` names the item for React.
   */
  renderRow?: (item: T, index: number) => React.ReactNode
  rowKey?: (item: T) => string
  /** Singular noun for the pager's sentence: 'plugin', 'skill', 'agent CLI'. */
  noun: string
  /**
   * What a row opens: a dialog over the list (the skill and plugin detail
   * modals). Rendered here so the surface owns its open/closed state, but it
   * is a fixed overlay and takes no room in the row below.
   */
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
    // How many things in this tab are waiting to be updated, as the corner
    // pip (owner, 2026-09-10) — the number you can read without opening the
    // tab, matched by a pip on each row's own mark inside it saying which.
    badgeCount: tab.updateCount,
    badgeLabel:
      tab.updateCount > 0
        ? `${tab.label}: ${tab.updateCount} ${tab.updateCount === 1 ? 'update' : 'updates'} available`
        : undefined,
    // The hourly check saw this source's repository move past the commit its
    // scan was taken at. The mark rides the tab so it is visible without
    // opening the source, and the glyph is decorative — the tab's name carries
    // the words, and Sync on the head line is where it is acted on.
    //
    // One mark, not two: where the tab can say HOW MANY, the count says it and
    // this glyph stands down. The glyph is what is left for a source that has
    // moved on with nothing countable behind it yet — the scan has not been
    // taken, so there is no per-item answer to give.
    icon: tab.updateAvailable && tab.updateCount === 0 ? <UpdateMark /> : undefined,
    ariaLabel:
      tab.updateAvailable && tab.updateCount === 0 ? `${tab.label} — update available` : undefined,
  }))

  const acrossSources = search.scope === 'sources'
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
          ariaLabel={
            acrossSources
              ? `Search ${title.toLowerCase()} across all sources`
              : `Search ${title.toLowerCase()} in the open tab`
          }
          placeholder={search.placeholder}
          controlsId={`${TABS_PREFIX}-panel-${activeTabId}`}
        />
      </div>
    ),
  }

  const activeTabLabel = tabs.find((tab) => tab.id === activeTabId)?.label ?? 'this tab'
  // What the pager is a pager OF: the tab, or — with a query on a search that
  // reads every source — the whole door.
  const pagedLabel =
    acrossSources && search.query.trim() !== '' ? `${title} across all sources` : `${title} in ${activeTabLabel}`

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
            {head ? <div className="mb-6">{head}</div> : null}
            {notices ? <div className="mb-4 space-y-2">{notices}</div> : null}
            {body ?? (
              <>
                <div className="space-y-8">
                  {view.groups.map((group) => {
                    const section = sectionByKey.get(group.key)
                    if (!section || !renderRow || !rowKey) return null
                    const heading = (
                      <ConnectorSectionHeading
                        // A group that started on an earlier page says so,
                        // rather than repeating its heading as if the rows
                        // above it were something else.
                        label={group.continued ? `${group.label} (continued)` : group.label}
                        count={group.total}
                      />
                    )
                    return (
                      <section key={group.key} className="space-y-3">
                        {section.leading ? (
                          // The source's mark leads its heading, and the
                          // heading keeps its own count: the kit section
                          // head, not a second heading idiom.
                          <div className="flex items-center gap-2.5">
                            {section.leading}
                            <div className="min-w-0 flex-1">{heading}</div>
                          </div>
                        ) : (
                          heading
                        )}
                        {/* One card per group, two columns inside it. The
                            card's hairlines do the separating the old grid's
                            gaps did, and its edge is the group's — the
                            heading names it, the card bounds it. The rows
                            keep the wide inset, so two rows' names and
                            Install buttons still do not read as one line
                            (extensions review, 2026-09-08). */}
                        <SettingCard as="ul" ariaLabel={group.label} columns={2}>
                          {section.items.slice(group.start, group.end).map((item, index) => (
                            <li key={rowKey(item)}>{renderRow(item, group.start + index)}</li>
                          ))}
                        </SettingCard>
                      </section>
                    )
                  })}
                </div>
                <Pager
                  page={view.page}
                  pageCount={view.pageCount}
                  rangeLabel={view.rangeLabel}
                  onPageChange={(page) => setPosition({ key: positionKey, page })}
                  ariaLabel={pagedLabel}
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
        { id: 'file', label: ADD_LOCAL_SKILL_SOURCE_LABEL, onSelect: add.onAddFromFile },
        { id: 'github', label: 'Add from GitHub…', onSelect: add.onAddFromGitHub },
      ]}
      trigger={(open, opened) => (
        <Tooltip content="Add source" placement="bottom">
          {/* The kit's icon button at `2xs` — `icon.size.lg`, the 22px step the
              kit ships FOR a glyph inside a tab strip, with the neutral ghost
              tone that is already this trigger's ink pair. It brings the chip
              radius the sub-ramp steps take and a transparent hit pad out to
              `size.hit-target-min`, so the drawn square stays 22px while the
              thing a pointer has to find is 24px. `mb-1` is all that is left:
              where the plus sits against the tabs is this row's business. */}
          <IconButton
            size="2xs"
            aria-label="Add source"
            aria-expanded={opened}
            aria-haspopup="menu"
            onClick={open}
            className="mb-1 shrink-0"
          >
            <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
              <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </IconButton>
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
/**
 * The head of a tab: the source's mark, its name at title weight, and ONE quiet
 * line under it — where it comes from (the repository, the folder, the
 * registry). Not what it holds: the tab already carries the count, the section
 * heading carries it again, and the rows are the holdings. Not what happened
 * to it either: a sync outcome or a partial read is a notice under the head,
 * where it can be read once and dismissed, rather than a clause the head
 * carries forever (extensions review, 2026-09-08 — the head had grown to four
 * lines of counts, links and caveats, and nobody could find the name in it).
 */
export function CatalogueHead({
  monogram,
  name,
  stateLine,
  actions,
}: {
  /** The source's mark — an avatar or a monogram chip — at the head's own size. */
  monogram?: React.ReactNode
  name: string
  /** Where this tab's rows come from. One line; it truncates rather than wraps. */
  stateLine: React.ReactNode
  actions?: React.ReactNode
}): JSX.Element {
  return (
    <div className="flex items-center gap-4">
      {monogram}
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-title font-semibold tracking-tight text-[color:var(--text-strong)]">{name}</h3>
        <p className="mt-0.5 truncate text-body text-[color:var(--text-muted)]">{stateLine}</p>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </div>
  )
}
