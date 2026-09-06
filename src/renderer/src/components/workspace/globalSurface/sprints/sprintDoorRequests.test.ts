import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { JSDOM } from 'jsdom'

// The module only reaches `window` inside its functions, so a plain static import
// is safe here: the globals below are in place long before anything is called.
import {
  claimSprintCreationForDoor,
  consumeSprintCreationDoorClaim,
  consumeSprintDoorDraft,
  consumeSprintDoorSelection,
  noteSprintDoorDraft,
  noteSprintDoorSelection,
  releaseSprintCreationDoorClaim,
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
const unsubscribe = subscribeCloseSprintWorkspaceRequests((workspaceId) => {
  closed.push(workspaceId)
})

requestCloseSprintWorkspace('ws-sprint-1')
assert.deepEqual(closed, ['ws-sprint-1'], 'the shell hears the close request')

dom.window.dispatchEvent(
  new dom.window.CustomEvent('multicode:close-sprint-workspace', { detail: { workspaceId: '' } }),
)
dom.window.dispatchEvent(new dom.window.CustomEvent('multicode:close-sprint-workspace'))
assert.deepEqual(closed, ['ws-sprint-1'], 'an empty or detail-less request is dropped')

unsubscribe()
void requestCloseSprintWorkspace('ws-sprint-2')
assert.deepEqual(closed, ['ws-sprint-1'], 'unsubscribing really detaches the listener')

// The door's claim on the next run creation (item 1811). Creation spends it;
// every route back out of the dialog releases it. A claim that outlived its
// dialog is the bug: the next run, started from anywhere, bounced to the door.
//
// The claim records WHICH door since item 2470 — there are two of them, and a
// workflow returned to Sprints would land in a list its own partition keeps it
// out of, which reads as a run that was never created.
assert.equal(consumeSprintCreationDoorClaim(), null, 'no claim until a door asks')

claimSprintCreationForDoor('sprints')
assert.equal(consumeSprintCreationDoorClaim(), 'sprints', 'the door claims the creation it opened')
assert.equal(consumeSprintCreationDoorClaim(), null, 'and spends it — the next creation is nobody’s')

claimSprintCreationForDoor('workflows')
assert.equal(
  consumeSprintCreationDoorClaim(),
  'workflows',
  'and the claim names the door, so a workflow comes back to Workflows',
)

claimSprintCreationForDoor('sprints')
releaseSprintCreationDoorClaim()
assert.equal(
  consumeSprintCreationDoorClaim(),
  null,
  'a dialog that goes away without creating anything leaves no claim behind',
)

// The inline new-row's own latch (item 2470): the Workflows `+` collects a goal
// and a roster and hands them to the EXISTING creation path, which reads them
// once as it opens.
assert.equal(consumeSprintDoorDraft(), null, 'no draft until an inline row fills one in')
noteSprintDoorDraft({ goal: 'Rebuild the settings screen', rosterId: 'roster-1' })
assert.deepEqual(
  consumeSprintDoorDraft(),
  { goal: 'Rebuild the settings screen', rosterId: 'roster-1' },
  'the goal and the roster reach the dialog that creates the run',
)
assert.equal(consumeSprintDoorDraft(), null, 'and only once — an abandoned dialog leaves no draft behind')

// The shell half of the seam. WorkspaceManager is a window-lifetime component
// with no node-renderable surface, so its wiring is read from source: the point
// under test is that no route out of the creation hub can forget the claim,
// because there is exactly one way out and it releases it.
const workspaceManager = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/workspace/WorkspaceManager.tsx'),
  'utf8',
)

function shellRegion(startAnchor: string, endAnchor: string): string {
  const start = workspaceManager.indexOf(startAnchor)
  assert.ok(start >= 0, `WorkspaceManager still has: ${startAnchor}`)
  const end = workspaceManager.indexOf(endAnchor, start + startAnchor.length)
  assert.ok(end > start, `WorkspaceManager still has: ${endAnchor} after ${startAnchor}`)
  return workspaceManager.slice(start, end)
}

// The New sprint dialog is the one creation surface (the wizard hub retired
// 2026-09-04), and every route out of it releases the claim.
const dialogClose = shellRegion('const closeNewSprintDialog = useCallback(', '}, [])')
assert.match(dialogClose, /releaseSprintCreationDoorClaim\(\)/, 'closing the dialog releases the door claim')

const dialogOpen = shellRegion('const openNewSprintDialog = useCallback(', 'const openSettings = useCallback(')
assert.match(dialogOpen, /releaseSprintCreationDoorClaim\(\)/, 'opening the dialog resets the claim to whoever opened this one')

// The door asks, the dialog opens, THEN the door claims — so the claim always
// belongs to the dialog the operator is looking at.
const doorRequest = shellRegion('subscribeNewSprintRequests((source, door) => {', '}),')
assert.ok(
  doorRequest.indexOf('openNewSprintDialog()') < doorRequest.indexOf('claimSprintCreationForDoor(door)'),
  'the door claims after the dialog it asked for has opened',
)
assert.match(
  doorRequest,
  /claimSprintCreationForDoor\(door\)/,
  'and it claims for the door that asked, not for Sprints by default',
)

// Creation reads the claim before closing, or closing would swallow it and a
// sprint started at the door would never come back to it.
const newSprintDialog = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/workspace/newSprint/NewSprintDialog.tsx'),
  'utf8',
)
const create = newSprintDialog.slice(newSprintDialog.indexOf('const cameFromDoor = consumeSprintCreationDoorClaim()'))
assert.ok(
  create.indexOf('consumeSprintCreationDoorClaim()') < create.indexOf('onClose()'),
  'the dialog consumes the claim before closing',
)
assert.match(
  create,
  /if \(cameFromDoor\) \{\s*noteSprintDoorSelection\(created\.statePath\)\s*openGlobalSurface\(cameFromDoor\)/,
  'and the return is to the door that claimed it — a run created from anywhere else stays where it was started, and a workflow never lands in Sprints',
)

void (async () => {
  // Delete-a-run waits on the teardown it asks for (item 1812): the promise the
  // shell hands back is the one the caller awaits before touching the run's files.
  let releaseTeardown = (): void => {}
  const teardownStarted: string[] = []
  const stop = subscribeCloseSprintWorkspaceRequests((workspaceId) => {
    teardownStarted.push(workspaceId)
    return new Promise<void>((resolve) => {
      releaseTeardown = resolve
    })
  })

  let closedSettled = false
  const closing = requestCloseSprintWorkspace('ws-live-run').then(() => {
    closedSettled = true
  })
  await Promise.resolve()
  assert.deepEqual(teardownStarted, ['ws-live-run'], 'the shell starts the teardown synchronously')
  assert.equal(closedSettled, false, 'and the caller is still waiting while terminals are being killed')

  releaseTeardown()
  await closing
  assert.equal(closedSettled, true, 'the caller resumes once teardown finishes')
  stop()

  // A run with no resident workspace is never asked to close, and a request with
  // nobody listening resolves rather than wedging the delete behind a teardown
  // that will never happen.
  let unlistenedSettled = false
  await requestCloseSprintWorkspace('ws-not-resident').then(() => {
    unlistenedSettled = true
  })
  assert.equal(unlistenedSettled, true, 'no listener means nothing to wait for')

  console.log('sprintDoorRequests tests passed')
})()
