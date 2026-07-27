import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { JSDOM } from 'jsdom'

// The module only reaches `window` inside its functions, so a plain static import
// is safe here: the globals below are in place long before anything is called.
import {
  claimSprintCreationForDoor,
  consumeSprintCreationDoorClaim,
  consumeSprintDoorSelection,
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
const unsubscribe = subscribeCloseSprintWorkspaceRequests((workspaceId) => closed.push(workspaceId))

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

// The door's claim on the next sprint creation (item 1811). Creation spends it;
// every route back out of the wizard releases it. A claim that outlived its
// wizard is the bug: the next sprint, started from anywhere, bounced to the door.
assert.equal(consumeSprintCreationDoorClaim(), false, 'no claim until the door asks')

claimSprintCreationForDoor()
assert.equal(consumeSprintCreationDoorClaim(), true, 'the door claims the creation it opened')
assert.equal(consumeSprintCreationDoorClaim(), false, 'and spends it — the next creation is nobody’s')

claimSprintCreationForDoor()
releaseSprintCreationDoorClaim()
assert.equal(
  consumeSprintCreationDoorClaim(),
  false,
  'a wizard that goes away without creating anything leaves no claim behind',
)

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

const dismissal = shellRegion('const dismissNewWorkspacePanel = useCallback(', '}, [])')
assert.match(dismissal, /setShowNewWorkspacePanel\(false\)/, 'dismissal hides the hub')
assert.match(dismissal, /releaseSprintCreationDoorClaim\(\)/, 'dismissal releases the door claim')

assert.equal(
  workspaceManager.split('setShowNewWorkspacePanel(false)').length - 1,
  1,
  'exactly one route hides the creation hub — every dismissal goes through dismissNewWorkspacePanel',
)

// The three routes item 1811 names, each of which used to hide the hub on its own.
const closeTabCommand = shellRegion("if (commandId === 'layout.tab.close') {", "if (commandId === 'panel.")
assert.match(closeTabCommand, /dismissNewWorkspacePanel\(\)/, 'layout.tab.close / Cmd-W dismisses')

const sidebarSelect = shellRegion('onSelectWorkspace={(id) => {', '}}')
assert.match(sidebarSelect, /dismissNewWorkspacePanel\(\)/, 'selecting a workspace in the sidebar dismisses')

const newChatOpener = shellRegion('const openNewChatPanel = useCallback(', 'const closeNewChatPanel')
assert.match(newChatOpener, /dismissNewWorkspacePanel\(\)/, 'opening the New Chat panel dismisses')

// Creation reads the claim before dismissing, or dismissal would swallow it and
// a sprint started at the door would never come back to it.
const create = shellRegion('const cameFromSprintsDoor = consumeSprintCreationDoorClaim()', 'openGlobalSurface(')
assert.ok(
  create.indexOf('consumeSprintCreationDoorClaim()') < create.indexOf('dismissNewWorkspacePanel()'),
  'handleCreate consumes the claim before dismissing the wizard',
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
