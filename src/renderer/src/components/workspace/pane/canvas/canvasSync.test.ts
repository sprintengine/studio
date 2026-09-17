import assert from 'node:assert/strict'

import {
  bufferCanvasPush,
  canApplyBufferedPush,
  canvasCommitOutcome,
  canvasFilesToAdd,
  canvasHashAfterFailedCommit,
  canvasPushMatchesBoard,
  canvasStateAfterPush,
  isCanvasBusy,
  isCanvasGestureBusy,
  shouldApplyCanvasPush,
  shouldCommitCanvasScene,
  shouldNoteHumanInput,
  CANVAS_HUMAN_INPUT_THROTTLE_MS,
  CANVAS_TEXT_CARET_GRACE_MS,
} from './canvasSync'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

// --- the person is holding the board ---------------------------------------

run('an idle editor is not busy, and neither is a missing one', () => {
  assert.equal(isCanvasBusy({ cursorButton: 'up' }), false)
  assert.equal(isCanvasBusy({}), false)
  assert.equal(isCanvasBusy(null), false)
  assert.equal(isCanvasBusy(undefined), false)
})

run('every gesture the editor can be in the middle of counts as busy', () => {
  const shape = { id: 'a' }
  assert.equal(isCanvasBusy({ newElement: shape }), true, 'drawing a shape')
  assert.equal(isCanvasBusy({ resizingElement: shape }), true, 'resizing one')
  assert.equal(isCanvasBusy({ editingTextElement: shape }), true, 'a caret in a label')
  assert.equal(isCanvasBusy({ multiElement: shape }), true, 'clicking through a polyline')
  assert.equal(isCanvasBusy({ selectionElement: shape }), true, 'a rubber band')
  assert.equal(isCanvasBusy({ editingLinearElement: shape }), true, 'dragging an arrow point')
  assert.equal(isCanvasBusy({ selectedElementsAreBeingDragged: true }), true, 'dragging a selection')
  assert.equal(isCanvasBusy({ isResizing: true }), true)
  assert.equal(isCanvasBusy({ isRotating: true }), true)
  assert.equal(isCanvasBusy({ isCropping: true }), true)
  // The pointer being down is the catch-all: a pan and a lasso that has not
  // moved yet set none of the fields above.
  assert.equal(isCanvasBusy({ cursorButton: 'down' }), true, 'the pointer is down')
})

run('a null element field is not a gesture', () => {
  // The editor spells "not drawing" as an explicit null rather than an absent
  // key, so the predicate must read it as falsy rather than as "present".
  assert.equal(
    isCanvasBusy({
      newElement: null,
      resizingElement: null,
      editingTextElement: null,
      multiElement: null,
      selectionElement: null,
      editingLinearElement: null,
      selectedElementsAreBeingDragged: false,
      isResizing: false,
      isRotating: false,
      isCropping: false,
      cursorButton: 'up',
    }),
    false,
  )
})

// --- which scene to apply ---------------------------------------------------

run('a push for another board or another workspace is not this tab’s', () => {
  const board = { workspaceId: 'ws-1', path: 'diagrams/arch.excalidraw' }
  assert.equal(canvasPushMatchesBoard({ ...board }, board), true)
  assert.equal(canvasPushMatchesBoard({ ...board, path: 'diagrams/other.excalidraw' }, board), false)
  assert.equal(canvasPushMatchesBoard({ ...board, workspaceId: 'ws-2' }, board), false)
})

run('a push at or below the revision on screen is dropped', () => {
  assert.equal(shouldApplyCanvasPush(4, 3), true)
  assert.equal(shouldApplyCanvasPush(3, 3), false, 'the same scene twice is still the same scene')
  assert.equal(shouldApplyCanvasPush(2, 3), false, 'and an older one would undo a newer one')
})

run('the buffer keeps one push per board — the newest', () => {
  const first = { revision: 4, elements: ['a'] }
  const second = { revision: 6, elements: ['b'] }
  assert.equal(bufferCanvasPush(null, first), first)
  assert.equal(bufferCanvasPush(first, second), second, 'a later scene supersedes an earlier one')
  assert.equal(bufferCanvasPush(second, first), second, 'and an out-of-order older one is ignored')
  assert.equal(
    bufferCanvasPush(second, { revision: 6, elements: ['c'] }),
    second,
    'an equal revision keeps the one already buffered',
  )
})

// --- echo suppression -------------------------------------------------------

run('a scene equal to the last one synced is not sent again', () => {
  assert.equal(shouldCommitCanvasScene('3-abc', null), true, 'nothing synced yet')
  assert.equal(shouldCommitCanvasScene('3-abc', '3-abc'), false, 'our own commit coming back')
  assert.equal(shouldCommitCanvasScene('4-def', '3-abc'), true, 'a real change')
})

run('only files the editor is missing are added', () => {
  const push = { a: { id: 'a' }, b: { id: 'b' }, c: null as unknown as Record<string, unknown> }
  assert.deepEqual(canvasFilesToAdd(push, { a: { id: 'a' } }), [{ id: 'b' }])
  assert.deepEqual(canvasFilesToAdd(push, { a: {}, b: {} }), [], 'nothing new is nothing to do')
  assert.deepEqual(canvasFilesToAdd({}, {}), [])
})

// --- the human-input note ---------------------------------------------------

run('the human-input note is throttled, and the first one always goes', () => {
  assert.equal(shouldNoteHumanInput(1_000, null), true)
  assert.equal(shouldNoteHumanInput(1_100, 1_000), false)
  assert.equal(shouldNoteHumanInput(1_000 + CANVAS_HUMAN_INPUT_THROTTLE_MS, 1_000), true)
})

run('a push is for this board whatever case its path arrived in', () => {
  const anyGlobal = globalThis as unknown as { window?: unknown }
  const hadWindow = 'window' in anyGlobal
  const previous = anyGlobal.window
  anyGlobal.window = { api: { platform: 'darwin' } }
  try {
    const board = { workspaceId: 'ws-1', path: 'diagrams/arch.excalidraw' }
    assert.equal(canvasPushMatchesBoard({ workspaceId: 'ws-1', path: 'diagrams/Arch.excalidraw' }, board), true)
    assert.equal(canvasPushMatchesBoard({ workspaceId: 'ws-2', path: 'diagrams/arch.excalidraw' }, board), false)
    assert.equal(canvasPushMatchesBoard({ workspaceId: 'ws-1', path: 'diagrams/other.excalidraw' }, board), false)
  } finally {
    if (hadWindow) anyGlobal.window = previous
    else delete anyGlobal.window
  }
})

// --- the buffered push's way out --------------------------------------------

run('a gesture holds a push; a caret holds it only for a while', () => {
  const shape = { id: 'a' }
  const now = 100_000
  const held = { busy: { selectedElementsAreBeingDragged: true }, bufferedAt: 0, now }
  assert.equal(canApplyBufferedPush(held), false, 'a drag holds it however long it has waited')

  const idle = { busy: { cursorButton: 'up' as const }, bufferedAt: now, now }
  assert.equal(canApplyBufferedPush(idle), true, 'an idle editor takes it at once')

  const caret = { busy: { editingTextElement: shape }, bufferedAt: now - 1_000, now }
  assert.equal(canApplyBufferedPush(caret), false, 'a caret that has just appeared still holds it')
  assert.equal(
    canApplyBufferedPush({ ...caret, bufferedAt: now - CANVAS_TEXT_CARET_GRACE_MS }),
    true,
    'a caret does not hold a push for good, whether or not anyone is typing into it',
  )
  assert.equal(canApplyBufferedPush({ ...idle, busy: null }), false, 'with no editor there is nothing to apply to')
})

run('a caret is not a gesture, and every gesture still is', () => {
  const shape = { id: 'a' }
  assert.equal(isCanvasGestureBusy({ editingTextElement: shape }), false)
  assert.equal(isCanvasBusy({ editingTextElement: shape }), true)
  for (const state of [
    { newElement: shape },
    { resizingElement: shape },
    { multiElement: shape },
    { selectionElement: shape },
    { editingLinearElement: shape },
    { selectedElementsAreBeingDragged: true },
    { isResizing: true },
    { isRotating: true },
    { isCropping: true },
    { cursorButton: 'down' as const },
  ]) {
    assert.equal(isCanvasGestureBusy(state), true, JSON.stringify(state))
  }
})

// --- what a tab remembers ---------------------------------------------------

run('applying a push records the revision and the hash of what MAIN sent', () => {
  const before = { revision: 4, appliedRevision: 4, syncedHash: 'local' }
  const after = canvasStateAfterPush(before, { revision: 7, mainHash: 'main' })
  assert.deepEqual(after, { revision: 7, appliedRevision: 7, syncedHash: 'main' })
})

run('a commit answer is stale, a reconcile, or an acceptance', () => {
  assert.deepEqual(canvasCommitOutcome({ revision: 4, elements: null }, 4), { kind: 'stale' })
  assert.deepEqual(canvasCommitOutcome({ revision: 3, elements: [] }, 4), { kind: 'stale' })
  assert.deepEqual(canvasCommitOutcome({ revision: 5, elements: [{}] }, 4), { kind: 'reconcile' })
  assert.deepEqual(canvasCommitOutcome({ revision: 5, elements: null }, 4), { kind: 'accepted', revision: 5 })
})

run('a failed commit puts its own hash back, and never somebody else\'s', () => {
  assert.equal(canvasHashAfterFailedCommit('sent', 'sent', 'before'), 'before')
  assert.equal(
    canvasHashAfterFailedCommit('newer', 'sent', 'before'),
    'newer',
    'a change that claimed the hash while this was in flight is the newer truth',
  )
})

console.log('canvas sync tests passed')
