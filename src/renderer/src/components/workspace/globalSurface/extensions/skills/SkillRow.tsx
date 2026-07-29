// One skill in a source listing: two targets in one row. The checkbox selects
// the skill for a batch install; the row body opens it to be read. They are
// siblings inside a plain container — never a button inside a button, which is
// invalid markup and gives the keyboard one target where the design has two.

import React from 'react'

import { FOCUS_RING_CLASS } from '../../../../ui/tokens'
import { skillGroupLabel, type SkillListItem } from './skillsSurfaceModel'

export function SkillRow({
  item,
  selected,
  onToggleSelect,
  onOpen,
  showGroup,
}: {
  item: SkillListItem
  selected: boolean
  onToggleSelect: () => void
  onOpen: () => void
  /** Search results span groups, so each row states the one it came from. */
  showGroup?: boolean
}): JSX.Element {
  return (
    <div
      className={`flex items-stretch overflow-hidden rounded-md border transition-colors ${
        selected
          ? 'border-[color:var(--border-strong)] bg-[color:var(--bg-selected)]'
          : 'border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] hover:bg-[color:var(--bg-hover)]'
      }`}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        aria-label={`Select ${item.name}`}
        onClick={onToggleSelect}
        // The row clips its children to its own rounded corners, so both
        // targets draw their focus ring INSIDE their box — an outset ring would
        // survive as a 1px sliver on the row's edge and read as no ring at all.
        className={`grid w-8 shrink-0 place-items-center ${FOCUS_RING_CLASS} focus-visible:ring-inset`}
      >
        <span
          aria-hidden="true"
          className={`grid h-3.5 w-3.5 place-items-center rounded-[3px] border ${
            selected
              ? 'border-[color:var(--accent-primary)] bg-[color:var(--accent-primary)] text-[color:var(--text-on-accent)]'
              : 'border-[color:var(--border-strong)] bg-[color:var(--bg-surface-raised)] text-transparent'
          }`}
        >
          <svg viewBox="0 0 16 16" fill="none" className="h-2.5 w-2.5">
            <path d="M3 8.5 6.5 12 13 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      <button
        type="button"
        onClick={onOpen}
        className={`group/skill-row flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pr-2.5 text-left ${FOCUS_RING_CLASS} focus-visible:ring-inset`}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[12px] font-medium text-[color:var(--text-strong)]">{item.name}</span>
          {item.description ? (
            <span className="truncate text-[11px] text-[color:var(--text-muted)]">{item.description}</span>
          ) : null}
        </span>
        {showGroup && item.group ? (
          <span className="shrink-0 font-mono text-[10px] text-[color:var(--text-subtle)]">
            {skillGroupLabel(item.group)}
          </span>
        ) : null}
        <FileCountChip count={item.fileCount} />
        {item.hasExecutables ? (
          <span className="shrink-0 text-[10px] text-[color:var(--text-subtle)]">Runs scripts</span>
        ) : null}
        {item.installed ? (
          <span className="shrink-0 text-[11px] text-[color:var(--text-muted)]">Installed</span>
        ) : null}
        {/* The row body is the target; "Read" names what it does when the
            pointer or the keyboard is on it, and stays out of the way of the
            disclosures otherwise. */}
        <span className="shrink-0 text-[11px] text-[color:var(--text-muted)] opacity-0 transition-opacity group-hover/skill-row:opacity-100 group-focus-visible/skill-row:opacity-100">
          Read
        </span>
      </button>
    </div>
  )
}

export function FileCountChip({ count }: { count: number }): JSX.Element {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-[3px] bg-[color:var(--bg-active)] px-1.5 py-px text-[10px] tabular-nums text-[color:var(--text-subtle)]"
      title={`${count} file${count === 1 ? '' : 's'}`}
    >
      <svg viewBox="0 0 16 16" fill="none" className="h-2.5 w-2.5" aria-hidden="true">
        <path
          d="M4 2h5l3 3v9H4zM9 2v3h3"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
      {count}
    </span>
  )
}
