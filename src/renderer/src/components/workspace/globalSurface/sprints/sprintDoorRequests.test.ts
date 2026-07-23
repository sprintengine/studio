import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// The module only reaches `window` inside its functions, so a plain static import
// is safe here: the globals below are in place long before anything is called.
import {
  consumeSprintDoorSelection,
  noteSprintDoorSelection,
  requestCloseSprintWorkspace,
  subscribeCloseSprintWorkspaceRequests,
} from './sprintDoorRequests'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
const anyGlobal = globalThis as unknown as Record<string, unknown>
anyGlobal.window = dom.window
anyGlobal.CustomEvent = dom.window.CustomEvent

// The door's selection latch (items 1765 + 1767): whoever hands the door a run —
// the shell after creating one, a Backlog run link — notes it before Sprints
// reopens; the surface reads it once as its initial selection.

// Nothing noted: the operator opened Sprints themselves, and the door keeps
// whatever they were last reading.
assert.equal(consumeSprintDoorSelection(), null, 'no claim without a handover')

noteSprintDoorSelection('/work/multicode/.multi-code/sprintengine/july-hardening/run.yaml')
assert.equal(
  consumeSprintDoorSelection(),
  '/work/multicode/.multi-code/sprintengine/july-hardening/run.yaml',
  'the handed-over run is what the surface opens on',
)
assert.equal(
  consumeSprintDoorSelection(),
  null,
  'and only once — reopening the door later restores the last selection instead',
)

// A second handover replaces the first: only the newest run is worth opening on.
noteSprintDoorSelection('/work/a/run.yaml')
noteSprintDoorSelection('/work/b/run.yaml')
assert.equal(consumeSprintDoorSelection(), '/work/b/run.yaml', 'the newest handover wins')

// Closing a run's workspace (item 1767): the door asks, the shell terminates the
// terminals and removes the workspace. A malformed request is ignored rather than
// handed on as an empty id — the shell must never be asked to close "nothing".
const closed: string[] = []
const unsubscribe = subscribeCloseSprintWorkspaceRequests((workspaceId) => closed.push(workspaceId))

requestCloseSprintWorkspace('ws-sprint-1')
assert.deepEqual(closed, ['ws-sprint-1'], 'the shell hears the close request')

dom.window.dispatchEvent(
  new dom.window.CustomEvent('multicode:close-sprint-workspace', { detail: { workspaceId: '' } }),
)
dom.window.dispatchEvent(new dom.window.CustomEvent('multicode:close-sprint-workspace'))
assert.deepEqual(closed, ['ws-sprint-1'], 'an empty or detail-less request is dropped')

unsubscribe()
requestCloseSprintWorkspace('ws-sprint-2')
assert.deepEqual(closed, ['ws-sprint-1'], 'unsubscribing really detaches the listener')

console.log('sprintDoorRequests tests passed')
