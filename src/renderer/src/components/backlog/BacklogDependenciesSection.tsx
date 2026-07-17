import { useState } from 'react'

import { InlineNotice, Popover, Section, Tooltip, TruncatedText } from '../ui'
import type { BacklogItem } from '../../utils/backlog'
import type {
  BacklogDependencyNode,
  BacklogDependencyState,
  BacklogPrerequisite,
} from '../../utils/backlogDependencies'
import { BACKLOG_BLOCKED_LABEL, BACKLOG_STATUS_LABEL } from './BacklogRow'
import {
  toggleDependencySlug,
  type BacklogActions,
  type BacklogDependencyChoice,
} from './BacklogItemContextMenu'
import { BacklogItemSearchPicker } from './BacklogItemSearchPicker'

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

// The status word for a prerequisite: the target's lifecycle word — with the
// derived Blocked presentation winning over a stored `ready`, exactly as on the
// target's own row — or "Unknown" for a dangling slug (no matching item) so a
// stale reference reads as a defect to clear, never as silently satisfied.
function prerequisiteStatusWord(
  prerequisite: BacklogPrerequisite,
  dependencyStateById?: ReadonlyMap<string, BacklogDependencyState>,
): string {
  if (prerequisite.status === 'unknown') return 'Unknown'
  if (prerequisite.target && dependencyStateById?.get(prerequisite.target.id) === 'blocked') {
    return BACKLOG_BLOCKED_LABEL
  }
  return BACKLOG_STATUS_LABEL[prerequisite.status]
}

export function BacklogDependenciesSection({
  item,
  node,
  dependencyChoices,
  dependencyStateById,
  actions,
  onNavigate,
}: {
  item: BacklogItem
  // The selected item's derived dependency record, or null if it has no node
  // (e.g. an epic, which the panel never passes here).
  node: BacklogDependencyNode | null
  // Every item this one may depend on (self filtered out below).
  dependencyChoices: ReadonlyArray<BacklogDependencyChoice>
  // Derived dependency markers per item id, so a referenced item that is itself
  // blocked reads "Blocked" here instead of a false "Ready".
  dependencyStateById?: ReadonlyMap<string, BacklogDependencyState>
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
                  dependencyStateById={dependencyStateById}
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
                  <NavigateButton
                    displayId={blocked.displayId}
                    title={blocked.title}
                    onNavigate={() => onNavigate(blocked.id)}
                  />
                  <StatusWord>
                    {dependencyStateById?.get(blocked.id) === 'blocked'
                      ? BACKLOG_BLOCKED_LABEL
                      : BACKLOG_STATUS_LABEL[blocked.status]}
                  </StatusWord>
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
  dependencyStateById,
  onNavigate,
  onRemove,
}: {
  prerequisite: BacklogPrerequisite
  dependencyStateById?: ReadonlyMap<string, BacklogDependencyState>
  onNavigate: (itemId: string) => void
  onRemove: () => void
}): JSX.Element {
  const target = prerequisite.target
  const statusWord = prerequisiteStatusWord(prerequisite, dependencyStateById)
  return (
    <li className="flex min-w-0 items-center gap-2">
      {target ? (
        <NavigateButton
          displayId={target.displayId}
          title={target.title}
          onNavigate={() => onNavigate(target.id)}
        />
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

// Dependency references read id-first (`MC-240 · title`), matching how items are
// referenced everywhere else; the title truncates and reveals its full text in a
// tooltip only when actually clipped (TruncatedText).
function NavigateButton({
  displayId,
  title,
  onNavigate,
}: {
  displayId?: string
  title: string
  onNavigate: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onNavigate}
      className="interactive inline-flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-left text-[12px] text-[color:var(--text-default)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
    >
      {displayId ? (
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-[color:var(--text-muted)]">
          {displayId}
        </span>
      ) : null}
      <TruncatedText as="span" text={title} className="min-w-0 flex-1" />
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

// The add/remove editor is search-first: opening it never renders the entire
// Backlog. A typed item code, title, or slug filters real candidates; toggling a
// result rewrites the full `dependsOn` set and keeps the picker open so several
// prerequisites can be set in one pass.
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
      popupRole="dialog"
      placement="bottom-end"
      surfaceClassName="min-w-[19rem] p-1"
      renderTrigger={({ ref, togglePopover, open: opened, triggerProps }) => (
        <button
          ref={ref}
          type="button"
          aria-haspopup="dialog"
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
      <BacklogItemSearchPicker
        options={candidates.map((candidate) => ({
          id: candidate.id,
          value: candidate.slug,
          title: candidate.title,
          displayId: candidate.displayId,
          searchText: candidate.slug,
        }))}
        selectedValues={dependsOn}
        ariaLabel="Search prerequisite items"
        noOptionsMessage="No other items."
        multiple
        resultRole="listbox"
        onSelect={(candidate) => onToggle(candidate.value)}
      />
    </Popover>
  )
}
