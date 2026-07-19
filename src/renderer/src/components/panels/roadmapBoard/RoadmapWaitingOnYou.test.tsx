import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { collectRoadmapInbox, RoadmapWaitingOnYou } from './RoadmapWaitingOnYou'
import type { LoadedRoadmap } from './roadmapBoardData'
import type { RoadmapBoardLane } from '../../../../../shared/sprintengine/roadmap-surface'

function lane(over: Partial<RoadmapBoardLane> & { lane: string }): RoadmapBoardLane {
  return {
    units: [],
    doneCount: 0,
    total: 0,
    reason: 'eligible',
    attention: 'none',
    ...over,
  }
}

function roadmap(title: string, lanes: RoadmapBoardLane[]): LoadedRoadmap {
  return {
    roadmapRef: `backlog/roadmaps/${title}.md`,
    title,
    path: `backlog/roadmaps/${title}.md`,
    roadmap: { policy: { advance: 'approve', merge: 'manual', concurrency: 1 }, projects: [], body: '', lanes: [], issues: [] },
    lanes,
    stateView: { roadmapRef: `backlog/roadmaps/${title}.md`, title, lanes: [] },
  }
}

// collectRoadmapInbox folds every attention-needing lane across roadmaps into one
// list, and drops the quiet ones.
const roadmaps = [
  roadmap('platform', [
    lane({ lane: 'Backend', attention: 'approval' }),
    lane({ lane: 'Docs', attention: 'none' }),
  ]),
  roadmap('mobile', [
    lane({ lane: 'App', attention: 'merge' }),
    lane({ lane: 'Infra', attention: 'paused', parked: { reason: 'run_failed', itemRef: 'backlog/x.md', at: '' } }),
  ]),
]

const inbox = collectRoadmapInbox(roadmaps)
assert.equal(inbox.length, 3, 'only attention-needing lanes are collected')
assert.deepEqual(
  inbox.map((entry) => entry.lane.lane),
  ['Backend', 'App', 'Infra'],
)

// Empty state renders the plain "all caught up" copy, not a bespoke alert.
const empty = renderToStaticMarkup(<RoadmapWaitingOnYou entries={[]} onSelect={() => {}} />)
assert.ok(empty.includes('All caught up'), 'empty inbox shows the caught-up copy')

// Populated state renders each lane with its attention label.
const populated = renderToStaticMarkup(<RoadmapWaitingOnYou entries={inbox} onSelect={() => {}} />)
assert.ok(populated.includes('Backend'), 'renders the approval lane')
assert.ok(populated.includes('Start next'), 'approval lane shows the Start next affordance label')
assert.ok(populated.includes('Waiting to merge'), 'merge lane shows the merge label')
assert.ok(populated.includes('Paused'), 'parked lane shows Paused')

console.log('RoadmapWaitingOnYou: all assertions passed')
