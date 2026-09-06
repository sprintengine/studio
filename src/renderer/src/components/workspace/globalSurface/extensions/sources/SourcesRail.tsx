// The nested Sources rail, shared by the kinds a source can hold.
//
// The Extensions rail lists kinds; sources are instances, unbounded, and live
// one level in (the 2026-07-28 ruling). Skills owned this rail first. Plugins
// share it now: the same list, the same Add and the same Discover, with a
// state line each kind writes for itself ("12 skills", "254 plugins",
// "No plugins here") — a source is never hidden from a kind it lacks, because
// hiding is how a person loses a source.

import React from 'react'

import { sourceHasUpdate, type SkillSource } from '../../../../../../../shared/skills'
import { FOCUS_RING_CLASS } from '../../../../ui/tokens'
import { SurfaceRail, type SurfaceRailRow } from '../../surfaceSubstrate'
import { SourceMonogram } from '../skills/SourceMonogram'
import { sourceDisplayMonogram, sourceDisplayName } from '../skills/skillsSurfaceModel'

export type SourcesRailRow = {
  source: SkillSource
  /** The kind's own count line for this source. */
  stateLine: string
}

export function SourcesRail({
  ariaLabel,
  rows,
  selectedId,
  onSelect,
  onAdd,
  discover,
}: {
  /** Names the nav for the kind it serves: "Skill sources", "Plugin sources". */
  ariaLabel: string
  rows: readonly SourcesRailRow[]
  selectedId: string | null
  onSelect: (sourceId: string) => void
  onAdd: () => void
  /** The Discover foot row: what it searches, whether it is open, and how to open it. */
  discover: { subtitle: string; active: boolean; onOpen: () => void }
}): JSX.Element {
  const railRows: SurfaceRailRow[] = rows.map(({ source, stateLine: kindLine }) => {
    const name = sourceDisplayName(source)
    // The hourly check saw the repository move past the scanned commit: the
    // mark stays on the row until Sync lands the source at head.
    const stateLine = sourceHasUpdate(source) ? `${kindLine} · Update available` : kindLine
    return {
      id: source.id,
      title: name,
      stateLine,
      // The rail truncates hard at 216px, so the hover carries the untruncated
      // name, the count, and what the source actually is.
      tooltip: `${name} — ${stateLine}${source.blurb ? `. ${source.blurb}` : ''}`,
      icon: <SourceMonogram monogram={sourceDisplayMonogram(source)} />,
    }
  })
  return (
    <nav
      aria-label={ariaLabel}
      className="flex w-[216px] shrink-0 flex-col overflow-y-auto border-r border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] p-2.5"
    >
      <SurfaceRail
        label="Sources"
        rows={railRows}
        selectedId={discover.active ? null : selectedId}
        onSelect={onSelect}
        newAffordance={{ label: 'Add a source', onActivate: onAdd }}
      />
      <div className="mt-auto border-t border-[color:var(--border-subtle)] pt-2">
        <button
          type="button"
          aria-current={discover.active ? 'true' : undefined}
          onClick={discover.onOpen}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${FOCUS_RING_CLASS} ${
            discover.active ? 'bg-[color:var(--bg-selected)]' : 'hover:bg-[color:var(--bg-hover)]'
          }`}
        >
          <CompassGlyph />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-body font-medium text-[color:var(--text-strong)]">Discover</span>
            <span className="truncate text-meta text-[color:var(--text-subtle)]">{discover.subtitle}</span>
          </span>
        </button>
      </div>
    </nav>
  )
}

function CompassGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-md shrink-0 text-[color:var(--text-muted)]" aria-hidden="true">
      <circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeWidth="1.3" />
      <path d="m10.2 5.8-1.3 3.1-3.1 1.3 1.3-3.1z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  )
}
