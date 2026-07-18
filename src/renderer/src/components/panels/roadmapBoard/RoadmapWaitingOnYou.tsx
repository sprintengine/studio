// The "Waiting on you" inbox for the roadmap board — the review-queue idiom
// (InboxRow, plain "Awaiting you" copy), NOT a new alert system. It folds every
// lane across every roadmap that needs a human decision into one scannable list:
// a lane awaiting a start approval, one waiting on a merge, or one that parked.
// Selecting a row scrolls its track into view; the action itself lives on the
// track's own controls, so the inbox stays a summary, never a second control set.

import React from 'react'

import { InboxRow, LifecycleGlyph, type LifecycleState } from '../../ui'
import type { LoadedRoadmap } from './roadmapBoardData'
import type { RoadmapBoardLane, RoadmapLaneAttention } from '../../../../../shared/sprintengine/roadmap-surface'

export type RoadmapInboxEntry = {
  roadmapRef: string
  roadmapTitle: string
  lane: RoadmapBoardLane
}

const ATTENTION_GLYPH: Record<Exclude<RoadmapLaneAttention, 'none'>, LifecycleState> = {
  approval: 'ready',
  merge: 'review',
  paused: 'paused',
}

const ATTENTION_TRAILING: Record<Exclude<RoadmapLaneAttention, 'none'>, string> = {
  approval: 'Start next',
  merge: 'Waiting to merge',
  paused: 'Paused',
}

export function collectRoadmapInbox(roadmaps: ReadonlyArray<LoadedRoadmap>): RoadmapInboxEntry[] {
  const entries: RoadmapInboxEntry[] = []
  for (const roadmap of roadmaps) {
    for (const lane of roadmap.lanes) {
      if (lane.attention === 'none') continue
      entries.push({ roadmapRef: roadmap.roadmapRef, roadmapTitle: roadmap.title, lane })
    }
  }
  return entries
}

export function RoadmapWaitingOnYou({
  entries,
  onSelect,
}: {
  entries: ReadonlyArray<RoadmapInboxEntry>
  onSelect: (roadmapRef: string, lane: string) => void
}): JSX.Element {
  if (entries.length === 0) {
    return (
      <div className="px-3 py-4 text-[12px] leading-5 text-[color:var(--text-muted)]">
        All caught up. Nothing is waiting on you right now.
      </div>
    )
  }
  return (
    <ul aria-label="Waiting on you">
      {entries.map((entry) => {
        const attention = entry.lane.attention as Exclude<RoadmapLaneAttention, 'none'>
        return (
          <li key={`${entry.roadmapRef}:${entry.lane.lane}`}>
            <InboxRow
              leading={<LifecycleGlyph state={ATTENTION_GLYPH[attention]} />}
              title={entry.lane.lane}
              supporting={supportingLine(entry)}
              trailing={ATTENTION_TRAILING[attention]}
              ariaLabel={`${entry.lane.lane} in ${entry.roadmapTitle}: ${ATTENTION_TRAILING[attention]}`}
              onSelect={() => onSelect(entry.roadmapRef, entry.lane.lane)}
            />
          </li>
        )
      })}
    </ul>
  )
}

function supportingLine(entry: RoadmapInboxEntry): string {
  const attention = entry.lane.attention as Exclude<RoadmapLaneAttention, 'none'>
  if (attention === 'paused' && entry.lane.parked?.reason && entry.lane.parked.reason !== 'paused') {
    return `${entry.roadmapTitle} · needs a look before it continues`
  }
  if (attention === 'merge') {
    return `${entry.roadmapTitle} · a pull request is ready to merge`
  }
  if (attention === 'approval') {
    return `${entry.roadmapTitle} · the next step is ready to start`
  }
  return entry.roadmapTitle
}
