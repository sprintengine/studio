import assert from 'node:assert/strict'
import type { Workspace } from '../types/workspace'
import { WORKSPACE_AUTO_ARCHIVE_AFTER_MS, shouldAutoArchiveWorkspace } from './workspaceAutoArchive'

const NOW = 1_000_000_000_000
const DAY = 24 * 60 * 60 * 1000

// Only the fields the predicate reads; cast at the test boundary keeps the
// fixtures readable without an `any`.
function ws(fields: Partial<Workspace>): Workspace {
  return {
    id: 'w',
    name: 'w',
    mode: 'standard',
    createdAt: NOW - 10 * DAY,
    lastTerminalActivityAt: null,
    sprintEngineState: null,
    sprintEngineAutoState: {},
    ...fields,
  } as unknown as Workspace
}

// The 5-day idle rule, measured from last real work (creation or typing).
assert.equal(shouldAutoArchiveWorkspace(ws({}), NOW), true, 'idle 10 days archives')
assert.equal(
  shouldAutoArchiveWorkspace(ws({ lastTerminalActivityAt: NOW - DAY }), NOW),
  false,
  'typed yesterday stays',
)
assert.equal(
  shouldAutoArchiveWorkspace(ws({ createdAt: NOW - WORKSPACE_AUTO_ARCHIVE_AFTER_MS + 1 }), NOW),
  false,
  'just inside the window stays',
)

// Never re-archive, never archive starred or the Automations host.
assert.equal(shouldAutoArchiveWorkspace(ws({ archivedAt: NOW - DAY }), NOW), false, 'already archived')
assert.equal(
  shouldAutoArchiveWorkspace(ws({ highlight: { starred: true, color: null } }), NOW),
  false,
  'starred never archives',
)
assert.equal(
  shouldAutoArchiveWorkspace(ws({ mode: 'automations-host' as Workspace['mode'] }), NOW),
  false,
  'automations host never archives',
)

// Sprints with pending work never archive; finished merged runs do.
const sprintState = (tasks: { status: string }[], vcs?: { pullRequestState: string }) =>
  ({ tasks, vcs } as unknown as Workspace['sprintEngineState'])
assert.equal(
  shouldAutoArchiveWorkspace(
    ws({ mode: 'sprintengine' as Workspace['mode'], sprintEngineState: sprintState([{ status: 'in_progress' }]) }),
    NOW,
  ),
  false,
  'in-progress sprint never archives',
)
assert.equal(
  shouldAutoArchiveWorkspace(
    ws({
      mode: 'sprintengine' as Workspace['mode'],
      sprintEngineState: sprintState([{ status: 'done' }], { pullRequestState: 'open' }),
    }),
    NOW,
  ),
  false,
  'finished-but-unmerged sprint never archives',
)
assert.equal(
  shouldAutoArchiveWorkspace(
    ws({
      mode: 'sprintengine' as Workspace['mode'],
      sprintEngineState: sprintState([{ status: 'done' }], { pullRequestState: 'merged' }),
    }),
    NOW,
  ),
  true,
  'merged sprint archives once idle',
)

console.log('workspaceAutoArchive tests passed')
