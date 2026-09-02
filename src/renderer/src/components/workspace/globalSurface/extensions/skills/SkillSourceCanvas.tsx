// A source, listed in the shape its own scan earned.
//
// One skill is a skill page — a list of one is not a list. A couple of dozen
// ungrouped skills are one list. A grouped source is two panes, one group at a
// time, so a 41-skill repository never lands 41 rows at once. Past the browsing
// threshold the page is search-first and stays empty until it is asked, because
// nobody reads 103 rows. The connector skills are not listed here at all: they
// belong to the MCP servers they ship with, and that is where they are browsed.
//
// Which of those applies is `sourceLayout()`'s decision (src/shared/skills.ts);
// this file only renders it.

import React from 'react'

import type { ScanResult, SkillSource } from '../../../../../../../shared/skills'
import {
  EmptyState as KitEmptyState,
  GhostButton,
  InboxSearchInput,
  InlineNotice,
  OutlineButton,
  PrimaryButton,
  Section,
} from '../../../../ui'
import { FOCUS_RING_CLASS } from '../../../../ui/tokens'
import { formatRelativeTime } from '../../../../../utils/time'
import { SkillRow } from './SkillRow'
import { SourceMonogram } from './SourceMonogram'
import {
  deriveSourceView,
  describeSourceMeta,
  sourceDisplayMonogram,
  sourceDisplayName,
  type SkillGroupTab,
  type SkillInstallAvailability,
  type SkillListItem,
  type SkillScanLoad,
} from './skillsSurfaceModel'

/**
 * Sync, as the header sees it. The outcome is one line of plain text next to
 * the source's other facts — never a modal, and never a diff: what changed
 * inside a skill is the repository's commit history to answer, which is what
 * `onOpenHistory` opens.
 */
export type SkillSourceSyncState = {
  /** Null for a source with no repository to re-read. */
  onSync: (() => void) | null
  syncing: boolean
  /** What the last sync did, in one line. Null until one has run. */
  outcome: string | null
  /** Set when the last sync failed — the list on screen is the old one. */
  error: string | null
  /** Opens the repository's own commit history. Null for non-repository sources. */
  onOpenHistory: (() => void) | null
}

export type SkillSourceCanvasProps = {
  source: SkillSource
  scan: ScanResult
  scanLoad: SkillScanLoad
  installedDirNames: ReadonlySet<string>
  /** Non-null when the workspace's installed skills could not be read. */
  installedError: string | null
  activeGroup: string | null
  onActiveGroupChange: (group: string | null) => void
  query: string
  onQueryChange: (query: string) => void
  selected: ReadonlySet<string>
  onToggleSelect: (skillId: string) => void
  onSelectAll: (skillIds: string[]) => void
  onClearSelection: () => void
  onOpenSkill: (skillId: string) => void
  availability: SkillInstallAvailability
  installing: string | null
  onInstallSelected: () => void
  sync: SkillSourceSyncState
  onBrowseMcpServers: () => void
  /** A source of one skill IS that skill's page — a list of one is not a list.
   *  The page is wired once, by the surface, and rendered here; `embedded`
   *  renders it under this canvas's own source header. */
  renderSkillPage: (skillId: string, options?: { embedded?: boolean }) => React.ReactNode
}

export function SkillSourceCanvas(props: SkillSourceCanvasProps): JSX.Element {
  const rowProps = {
    selected: props.selected,
    onToggleSelect: props.onToggleSelect,
    onOpenSkill: props.onOpenSkill,
  }
  const batchProps = {
    selected: props.selected,
    availability: props.availability,
    installing: props.installing,
    onClearSelection: props.onClearSelection,
    onInstallSelected: props.onInstallSelected,
  }
  const view = deriveSourceView({
    source: props.source,
    scan: props.scan,
    installedDirNames: props.installedDirNames,
    activeGroup: props.activeGroup,
    query: props.query,
  })

  return (
    <div className="min-w-0">
      <SourceHeader source={props.source} scanLoad={props.scanLoad} sync={props.sync} />

      {props.sync.error ? (
        <div className="mt-3">
          <InlineNotice
            tone="error"
            title={`${sourceDisplayName(props.source)} could not be synced.`}
            hint="Nothing changed — the skills below are the ones from the last successful read."
            detail={props.sync.error}
          />
        </div>
      ) : null}

      {props.installedError ? (
        <div className="mt-3">
          <InlineNotice tone="warn">
            {`Installed skills in this workspace could not be read, so nothing is marked as installed: ${props.installedError}`}
          </InlineNotice>
        </div>
      ) : null}

      {view.kind === 'connectors' ? (
        <EmptyState
          title={`These ${view.count} skills are paired with their MCP connectors.`}
          body="Browse them from MCP servers, where the server each one belongs to is visible."
          action={<OutlineButton onClick={props.onBrowseMcpServers}>Browse MCP servers</OutlineButton>}
        />
      ) : view.kind === 'empty' ? (
        <EmptyState
          title="Nothing in this source scanned as a skill."
          body="A skill is a directory containing SKILL.md. This source has none."
        />
      ) : view.kind === 'solo' ? (
        <div className="mt-5">{props.renderSkillPage(view.skill.skillId, { embedded: true })}</div>
      ) : view.kind === 'flat' ? (
        <Section
          inset={false}
          level={4}
          title="Skills"
          count={view.items.length}
          action={
            <GhostButton size="xs" onClick={() => props.onSelectAll(view.items.map((item) => item.skillId))}>
              Select all
            </GhostButton>
          }
        >
          <SkillRows items={view.items} {...rowProps} />
          <BatchBar {...batchProps} />
        </Section>
      ) : view.kind === 'grouped' ? (
        <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-[196px_minmax(0,1fr)]">
          <Section inset={false} level={4} title="Groups" count={view.groups.length} className="min-w-0">
            <GroupTree
              groups={view.groups}
              activeGroup={view.activeGroup}
              onSelect={props.onActiveGroupChange}
            />
          </Section>
          <Section
            inset={false}
            level={4}
            className="min-w-0"
            title={groupLabelOf(view.groups, view.activeGroup)}
            count={view.items.length}
            action={
              view.items.length > 0 ? (
                <GhostButton
                  size="xs"
                  onClick={() => props.onSelectAll(view.items.map((item) => item.skillId))}
                >
                  Select all
                </GhostButton>
              ) : null
            }
          >
            <SkillRows items={view.items} {...rowProps} />
            <BatchBar {...batchProps} />
          </Section>
        </div>
      ) : (
        <>
          {/* The header already states the count; the chips already enumerate
              the categories. The search box says nothing they do not. */}
          <div className="mt-3 max-w-[340px]">
            <InboxSearchInput
              value={props.query}
              onChange={props.onQueryChange}
              ariaLabel={`Search the ${props.scan.skills.length} skills in ${sourceDisplayName(props.source)}`}
              placeholder={`Search ${props.scan.skills.length} skills`}
            />
          </div>
          {view.groups.length > 0 ? (
            <GroupChips
              groups={view.groups}
              activeGroup={view.activeGroup}
              onSelect={(group) => {
                props.onQueryChange('')
                props.onActiveGroupChange(group)
              }}
            />
          ) : null}
          {view.prompt ? (
            <EmptyState title={view.prompt} />
          ) : (
            <Section
              inset={false}
              level={4}
              title={view.query.trim() ? 'Results' : groupLabelOf(view.groups, view.activeGroup ?? '')}
              count={view.items.length}
              action={
                <GhostButton
                  size="xs"
                  onClick={() => props.onSelectAll(view.items.map((item) => item.skillId))}
                >
                  Select all
                </GhostButton>
              }
            >
              <SkillRows items={view.items} showGroup={Boolean(view.query.trim())} {...rowProps} />
              <BatchBar {...batchProps} />
            </Section>
          )}
        </>
      )}
    </div>
  )
}

function SourceHeader({
  source,
  scanLoad,
  sync,
}: {
  source: SkillSource
  scanLoad: SkillScanLoad
  sync: SkillSourceSyncState
}): JSX.Element {
  const meta = describeSourceMeta(source, scanLoad)
  const scanned = source.scannedAt ? formatRelativeTime(source.scannedAt) : ''
  return (
    <header className="flex items-start gap-3">
      <SourceMonogram monogram={sourceDisplayMonogram(source)} size="lg" />
      <div className="min-w-0 flex-1">
        <h3 className={`text-title font-semibold text-[color:var(--text-strong)] ${source.repo ? 'font-mono' : ''}`}>
          {sourceDisplayName(source)}
        </h3>
        {/* The sync outcome joins the facts the source already states, rather
            than arriving as a modal over them. It is allowed to wrap: a line
            that names a skill which failed to update must not be clipped. */}
        <p className="mt-0.5 max-w-[74ch] text-meta text-[color:var(--text-muted)]">
          {meta.join(' · ')}
          {scanned ? `${meta.length > 0 ? ' · ' : ''}scanned ${scanned}` : ''}
          {sync.outcome ? `${meta.length > 0 || scanned ? ' · ' : ''}${sync.outcome}` : ''}
        </p>
        {/* A repository source's blurb is generated from the same counts the
            line above already states, so it would only repeat them. */}
        {source.blurb && !(source.repo && source.blurb.includes(source.repo)) ? (
          <p className="mt-1.5 max-w-[74ch] text-meta text-[color:var(--text-muted)]">{source.blurb}</p>
        ) : null}
      </div>
      {sync.onSync || sync.onOpenHistory ? (
        <div className="flex shrink-0 items-center gap-2">
          {/* What changed inside a skill is the repository's history to answer,
              and it answers it better than anything rendered here would. */}
          {sync.onOpenHistory ? (
            <GhostButton onClick={sync.onOpenHistory}>Commit history</GhostButton>
          ) : null}
          {sync.onSync ? (
            <OutlineButton onClick={sync.onSync} disabled={sync.syncing}>
              {sync.syncing ? 'Syncing…' : 'Sync'}
            </OutlineButton>
          ) : null}
        </div>
      ) : null}
    </header>
  )
}

function SkillRows({
  items,
  showGroup,
  selected,
  onToggleSelect,
  onOpenSkill,
}: {
  items: SkillListItem[]
  showGroup?: boolean
} & Pick<SkillSourceCanvasProps, 'selected' | 'onToggleSelect' | 'onOpenSkill'>): JSX.Element {
  return (
    <div role="list" className="mt-1.5 flex flex-col gap-0.5">
      {items.map((item) => (
        <div role="listitem" key={item.skillId}>
          <SkillRow
            item={item}
            selected={selected.has(item.skillId)}
            showGroup={showGroup}
            onToggleSelect={() => onToggleSelect(item.skillId)}
            onOpen={() => onOpenSkill(item.skillId)}
          />
        </div>
      ))}
    </div>
  )
}

function BatchBar({
  selected,
  availability,
  installing,
  onClearSelection,
  onInstallSelected,
}: Pick<
  SkillSourceCanvasProps,
  'selected' | 'availability' | 'installing' | 'onClearSelection' | 'onInstallSelected'
>): JSX.Element {
  const count = selected.size
  return (
    <div className="sticky bottom-0 mt-2.5 flex flex-wrap items-center gap-2.5 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-2.5 py-2">
      <span className="text-body font-medium text-[color:var(--text-strong)]">
        {count > 0 ? `${count} selected` : 'Nothing selected'}
      </span>
      {availability.reason ? (
        <span className="min-w-0 flex-1 text-meta text-[color:var(--text-subtle)]">{availability.reason}</span>
      ) : (
        <span className="flex-1" />
      )}
      <GhostButton onClick={onClearSelection} disabled={count === 0}>
        Clear
      </GhostButton>
      <PrimaryButton
        onClick={onInstallSelected}
        disabled={!availability.enabled || count === 0 || installing !== null}
      >
        {installing ?? `Install${count > 0 ? ` ${count}` : ''}`}
      </PrimaryButton>
    </div>
  )
}

function GroupTree({
  groups,
  activeGroup,
  onSelect,
}: {
  groups: SkillGroupTab[]
  activeGroup: string
  onSelect: (group: string) => void
}): JSX.Element {
  return (
    <ul role="list" aria-label="Groups" className="flex flex-col gap-px">
      {groups.map((group) => (
        <li key={group.name}>
          <button
            type="button"
            aria-current={group.name === activeGroup ? 'true' : undefined}
            onClick={() => onSelect(group.name)}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors ${FOCUS_RING_CLASS} ${
              group.name === activeGroup
                ? 'bg-[color:var(--bg-selected)] font-medium text-[color:var(--text-strong)]'
                : 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)]'
            }`}
          >
            <span className="min-w-0 flex-1 truncate text-body">{group.label}</span>
            <span className="shrink-0 text-meta tabular-nums text-[color:var(--text-subtle)]">
              {group.count}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function GroupChips({
  groups,
  activeGroup,
  onSelect,
}: {
  groups: SkillGroupTab[]
  activeGroup: string | null
  onSelect: (group: string | null) => void
}): JSX.Element {
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {groups.map((group) => {
        const pressed = group.name === activeGroup
        return (
          <button
            key={group.name}
            type="button"
            aria-pressed={pressed}
            onClick={() => onSelect(pressed ? null : group.name)}
            className={`inline-flex h-control-xs items-center gap-1.5 rounded-sm border px-2 text-meta transition-colors ${FOCUS_RING_CLASS} ${
              pressed
                ? 'border-[color:var(--border-strong)] bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
                : 'border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
            }`}
          >
            {group.label}
            <span className="tabular-nums text-[color:var(--text-subtle)]">{group.count}</span>
          </button>
        )
      })}
    </div>
  )
}

// The list heads on this surface are the kit's `Section` (title, count, one
// action) at `level={4}` with `inset={false}`, since each list brings its own
// row inset. A local `SectionHead` used to draw the same three things a size and
// an ink apart from every other door's heading; Discover renders its result
// lists under the same kit head.

/**
 * The one "there is nothing to list, and here is why" block on this surface.
 *
 * Now the kit's `EmptyState` at list density (MC-2117). Re-exported under this
 * name because `SkillsDiscover` imports it from here; the local styling is gone.
 */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string
  body?: string
  action?: React.ReactNode
}): JSX.Element {
  return <KitEmptyState density="list" title={title} body={body} action={action} />
}

function groupLabelOf(groups: SkillGroupTab[], name: string): string {
  return groups.find((group) => group.name === name)?.label ?? name
}
