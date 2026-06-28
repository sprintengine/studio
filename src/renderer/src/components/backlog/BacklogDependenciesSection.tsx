import { useState } from 'react'

import { InlineNotice, Popover, Section, Tooltip } from '../ui'
import type { BacklogItem } from '../../utils/backlog'
import type { BacklogDependencyNode, BacklogPrerequisite } from '../../utils/backlogDependencies'
import { BACKLOG_STATUS_LABEL } from './BacklogRow'
import {
  toggleDependencySlug,
  type BacklogActions,
  type BacklogDependencyChoice,
} from './BacklogItemContextMenu'

// Detail-pane dependency surface, the analog of BacklogLinksSection for the
// `dependsOn` axis. It renders the derived view (T2 backlogDependencies) — the
// item's prerequisites, the items it blocks (reverse edges), and a non-fatal
// cycle warning — plus the in-app editor (a checkable "Depends on…" popover) so
// prerequisites can be added/removed without leaving the pane. Nothing here is
// persisted beyond the dependent's `dependsOn:` frontmatter, rewritten through
// actions.setDependencies → window.api.updateBacklogDependencies → re-scan; the
// node is recomputed on every scan, so the view never desyncs from the files.
//
// Epics never declare prerequisites (they are grouping containers), so the
// section is absent for them — the panel passes a node only for leaf items.

// The status word for a prerequisite: the target's lifecycle word, or "Unknown"
// for a dangling slug (no matching item) so a stale reference reads as a defect
// to clear, never as silently satisfied.
function prerequisiteStatusWord(prerequisite: BacklogPrerequisite): string {
  return prerequisite.status === 'unknown' ? 'Unknown' : BACKLOG_STATUS_LABEL[prerequisite.status]
}

export function BacklogDependenciesSection({
  item,
  node,
  dependencyChoices,
  actions,
  onNavigate,
}: {
  item: BacklogItem
  // The selected item's derived dependency record, or null if it has no node
  // (e.g. an epic, which the panel never passes here).
  node: BacklogDependencyNode | null
  // Every item this one may depend on (self filtered out below).
  dependencyChoices: ReadonlyArray<BacklogDependencyChoice>
  actions: BacklogActions
  // Select another item by id (prerequisite / blocked target navigation).
  onNavigate: (itemId: string) => void
}): JSX.Element | null {
  if (!node) return null

  const { prerequisites, blocks, inCycle } = node

  const toggle = (slug: string): void => {
    const next = toggleDependencySlug(item.dependsOn, slug)
    actions.setDependencies(item, next.length > 0 ? next : null)
  }

  return (
    <Section
      title="Dependencies"
      level={4}
      inset
      className="shrink-0 border-b border-[color:var(--border-subtle)] pb-2"
      action={
        <DependsOnEditor item={item} dependencyChoices={dependencyChoices} onToggle={toggle} />
      }
    >
      <div className="flex flex-col gap-2 px-3">
        {inCycle ? (
          <InlineNotice tone="warn">
            This item is part of a dependency cycle. Break the loop — remove one prerequisite — so
            the chain can be ordered.
          </InlineNotice>
        ) : null}

        {prerequisites.length > 0 ? (
          <div className="flex flex-col gap-0.5">
            <SubsectionLabel>Prerequisites</SubsectionLabel>
            <ul className="flex flex-col gap-0.5">
              {prerequisites.map((prerequisite) => (
                <PrerequisiteRow
                  key={prerequisite.slug}
                  prerequisite={prerequisite}
                  onNavigate={onNavigate}
                  onRemove={() => toggle(prerequisite.slug)}
                />
              ))}
            </ul>
          </div>
        ) : null}

        {blocks.length > 0 ? (
          <div className="flex flex-col gap-0.5">
            <SubsectionLabel>Blocks</SubsectionLabel>
            <ul className="flex flex-col gap-0.5">
              {blocks.map((blocked) => (
                <li key={blocked.id} className="flex min-w-0 items-center gap-2">
                  <NavigateButton title={blocked.title} onNavigate={() => onNavigate(blocked.id)} />
                  <StatusWord>{BACKLOG_STATUS_LABEL[blocked.status]}</StatusWord>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {prerequisites.length === 0 && blocks.length === 0 && !inCycle ? (
          <p className="py-0.5 text-[12px] text-[color:var(--text-disabled)]">
            No prerequisites. Use “Depends on…” to add one.
          </p>
        ) : null}
      </div>
    </Section>
  )
}

function SubsectionLabel({ children }: { children: React.ReactNode }): JSX.Element {
  return <span className="text-[11px] text-[color:var(--text-muted)]">{children}</span>
}

function StatusWord({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <span className="shrink-0 text-[11px] tabular-nums text-[color:var(--text-subtle)]">{children}</span>
  )
}

// A prerequisite row: a resolved target is a navigable button (title + status
// word); a dangling slug renders as a focusable, non-actionable note carrying
// the missing slug and an "Unknown" word so the stale entry reads as a defect to
// clear. Either way a remove (×) button drops the slug from the item's
// `dependsOn`.
function PrerequisiteRow({
  prerequisite,
  onNavigate,
  onRemove,
}: {
  prerequisite: BacklogPrerequisite
  onNavigate: (itemId: string) => void
  onRemove: () => void
}): JSX.Element {
  const target = prerequisite.target
  const statusWord = prerequisiteStatusWord(prerequisite)
  return (
    <li className="flex min-w-0 items-center gap-2">
      {target ? (
        <NavigateButton title={target.title} onNavigate={() => onNavigate(target.id)} />
      ) : (
        <Tooltip
          content={`No backlog item matches “${prerequisite.slug}”. Remove the stale prerequisite or create the item.`}
          placement="top"
          wrapperClassName="inline-flex min-w-0 flex-1"
        >
          <span
            tabIndex={0}
            role="note"
            aria-label={`${prerequisite.slug}: unknown prerequisite, no matching item`}
            className="min-w-0 flex-1 truncate rounded px-1.5 py-1 font-mono text-[12px] text-[color:var(--text-disabled)] outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--border-strong)]"
          >
            {prerequisite.slug}
          </span>
        </Tooltip>
      )}
      <StatusWord>{statusWord}</StatusWord>
      <RemoveButton
        label={target ? `Remove prerequisite ${target.title}` : `Remove unknown prerequisite ${prerequisite.slug}`}
        onClick={onRemove}
      />
    </li>
  )
}

function NavigateButton({ title, onNavigate }: { title: string; onNavigate: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onNavigate}
      className="interactive inline-flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-left text-[12px] text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
    >
      <span className="min-w-0 truncate">{title}</span>
    </button>
  )
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }): JSX.Element {
  return (
    <Tooltip content="Remove" placement="top">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="interactive inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[color:var(--text-subtle)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
      >
        <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </Tooltip>
  )
}

// The add/remove editor: a "Depends on…" button opening a checkable candidate
// list (every other non-epic item), the detail-pane peer of the context menu's
// flyout. Toggling a row rewrites the full `dependsOn` set; the popover stays
// open so several can be set in one pass, and the checks reflect the current set
// — mirroring "Move to epic".
function DependsOnEditor({
  item,
  dependencyChoices,
  onToggle,
}: {
  item: BacklogItem
  dependencyChoices: ReadonlyArray<BacklogDependencyChoice>
  onToggle: (slug: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const dependsOn = item.dependsOn ?? []
  const candidates = dependencyChoices.filter((candidate) => candidate.id !== item.id)

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel="Set prerequisites"
      popupRole="menu"
      placement="bottom-end"
      surfaceClassName="max-h-[18rem] min-w-[220px] overflow-auto py-1"
      renderTrigger={({ ref, togglePopover, open: opened, triggerProps }) => (
        <button
          ref={ref}
          type="button"
          aria-haspopup="menu"
          aria-expanded={triggerProps['aria-expanded']}
          aria-controls={triggerProps['aria-controls']}
          onClick={togglePopover}
          className={`interactive inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors hover:bg-[color:var(--bg-hover)] ${
            opened ? 'bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]' : 'text-[color:var(--text-muted)] hover:text-[color:var(--text-strong)]'
          }`}
        >
          Depends on…
        </button>
      )}
    >
      {candidates.length === 0 ? (
        <p className="px-2.5 py-1.5 text-[12px] text-[color:var(--text-disabled)]">No other items</p>
      ) : (
        candidates.map((candidate) => {
          const checked = dependsOn.includes(candidate.slug)
          return (
            <button
              key={candidate.id}
              role="menuitemcheckbox"
              type="button"
              aria-checked={checked}
              onClick={() => onToggle(candidate.slug)}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
            >
              <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
                {checked ? (
                  <svg viewBox="0 0 16 16" fill="none" className="icon-xs">
                    <path d="M3.5 8.5L6.5 11.5L12.5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : null}
              </span>
              <span className="min-w-0 flex-1 truncate">{candidate.title}</span>
            </button>
          )
        })
      )}
    </Popover>
  )
}
