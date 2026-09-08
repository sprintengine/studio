import assert from 'node:assert/strict'

// The inline `+` at the end of a run door's list, driven in a real document
// (item 2470).
//
// Two things about it are only true in a DOM, and both were false when this
// suite was written. The first is where focus goes when the form closes: the
// file's own header promises "Escape or Cancel turns it back into the row with
// focus back on it", and the old `close()` called `plusRef.current?.focus()` in
// the same tick as `setOpen(false)` — while the form is open the plus is
// unmounted, so the ref is null and the call is a no-op. Focus stayed on the
// removed button and fell to `<body>`, which kills the rail's j/k navigation and
// sends the next Escape to the window listener that closes the whole door.
//
// The second is whether the `+` is there at all. The rail hid `afterRows`
// whenever its empty notice showed, so a search matching nothing removed the one
// control that makes a run — and if the form was open at the time, it was
// unmounted mid-sentence with the operator's goal in it.
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true })
const anyGlobal = globalThis as unknown as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
anyGlobal.window = domWindow
anyGlobal.document = dom.window.document
anyGlobal.navigator = dom.window.navigator
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
anyGlobal.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
anyGlobal.Node = dom.window.Node
anyGlobal.MouseEvent = dom.window.MouseEvent
anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
anyGlobal.CustomEvent = dom.window.CustomEvent
anyGlobal.getComputedStyle = dom.window.getComputedStyle
anyGlobal.localStorage = dom.window.localStorage
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
// This jsdom answers `'oninput' in document` with false, so react-dom takes its
// legacy value-change path and probes the focused node for these. Stubbed rather
// than fixed: the path is harmless here, and unstubbed it throws inside React's
// own event plumbing and buries the assertions in noise about IE.
const legacyEventShim = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>
legacyEventShim.attachEvent = () => {}
legacyEventShim.detachEvent = () => {}
class FakeResizeObserver { observe() {} unobserve() {} disconnect() {} }
anyGlobal.ResizeObserver = FakeResizeObserver
domWindow.ResizeObserver = FakeResizeObserver
dom.window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} })) as unknown as typeof dom.window.matchMedia
domWindow.api = {}

import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import type { SprintRunSummary } from '../../../../../../shared/sprintengine/runSummary'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { SprintsRail } from './SprintsRail'
import { WORKFLOWS_DOOR } from './runDoorCopy'

// One project open, so the Workflows row offers its goal field rather than the
// refusal it shows when there is no backlog to write a goal into.
useWorkspaceStore.setState({
  workspaces: [
    { id: 'ws-1', name: 'multicode', folderPath: '/work/multicode', agents: {}, panels: [] },
  ],
} as never)

const runs: SprintRunSummary[] = [
  {
    statePath: '/work/multicode/.multi-code/sprintengine/plan-it/run.yaml',
    teamName: 'plan-it',
    projectRoot: '/work/multicode',
    projectName: 'multicode',
    runtimeState: 'idle',
    taskCounts: { total: 0, done: 0, inProgress: 0, waiting: 0 },
    repoRollup: { declared: 0, merged: 0, open: 0 },
    needsInputCount: 0,
    branchName: null,
    worktreePath: null,
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
    sourceLabel: null,
    coordinatorSeat: { role: 'architect', agentId: 'architect' },
  },
]

const host = dom.window.document.createElement('div')
dom.window.document.body.appendChild(host)
const root = createRoot(host as unknown as Element)

function paint(search: string): void {
  act(() => {
    root.render(
      React.createElement(SprintsRail, {
        door: WORKFLOWS_DOOR,
        runs,
        selectedStatePath: null,
        projectFilter: null,
        search,
        sort: 'recent' as const,
        onSelect: () => {},
        onFilter: () => {},
        onSearch: () => {},
        onSort: () => {},
        onCreate: () => {},
      }),
    )
  })
}

function plus(): HTMLElement | undefined {
  return [...dom.window.document.querySelectorAll('button')].find((button) =>
    (button.textContent ?? '').includes(WORKFLOWS_DOOR.newRowLabel),
  ) as HTMLElement | undefined
}

function goalField(): HTMLTextAreaElement | null {
  return dom.window.document.querySelector(
    `textarea[aria-label="${WORKFLOWS_DOOR.newRowPrompt}"]`,
  ) as HTMLTextAreaElement | null
}

function activeTag(): string {
  return dom.window.document.activeElement?.tagName ?? 'NONE'
}

function press(node: Element, key: string): void {
  act(() => {
    node.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

function click(node: Element): void {
  act(() => {
    node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
}

function openTheForm(): HTMLTextAreaElement {
  const button = plus()
  assert.ok(button, 'the door offers its `+` at the end of the list')
  click(button)
  const field = goalField()
  assert.ok(field, 'pressing it opens the form in place, on the row where the plus was')
  // Opening moves focus into the first field, or the row is unusable from the
  // keyboard: the plus it replaced is gone, and focus has nowhere to be.
  assert.ok(
    dom.window.document.activeElement === field,
    `focus lands in the goal field, not on <${activeTag()}>`,
  )
  return field
}

// ── Escape and Cancel put focus back on the plus ────────────────────────────

paint('')
const escapeField = openTheForm()
press(escapeField, 'Escape')
assert.equal(goalField(), null, 'Escape turns the form back into the row')
assert.ok(
  dom.window.document.activeElement === plus(),
  `Escape returns focus to the plus, not to <${activeTag()}>`,
)

const cancelField = openTheForm()
const cancel = [...dom.window.document.querySelectorAll('button')].find(
  (button) => button.textContent?.trim() === 'Cancel',
)
assert.ok(cancel, 'the open form offers Cancel')
assert.ok(cancelField, 'and the field it will abandon')
click(cancel)
assert.equal(goalField(), null, 'Cancel turns the form back into the row')
assert.ok(
  dom.window.document.activeElement === plus(),
  `Cancel returns focus to the plus, not to <${activeTag()}>`,
)

// Nothing is focused merely by the row mounting: the restore is bound to the
// open→closed transition, so a rail that repaints does not yank focus out of
// whatever the operator was actually using.
const restored = plus()
assert.ok(restored, 'the plus is back')
act(() => {
  restored.blur()
})
paint('')
assert.ok(dom.window.document.activeElement !== plus(), 'a repaint does not steal focus')

// ── The `+` survives a search that matches nothing ──────────────────────────

paint('nothing-matches-this')
assert.match(
  dom.window.document.body.textContent ?? '',
  new RegExp(WORKFLOWS_DOOR.emptyRail.searched),
  'the narrowed rail says why it is empty',
)
assert.ok(
  plus(),
  'and still offers the `+` — a search for a run that does not exist yet is exactly when you want to make one',
)

// ── An open form survives the rows going to zero ────────────────────────────
// The worst version of the same bug: the form was unmounted while it was being
// typed into, and the half-written goal went with it, with nothing said.
//
// Asserted on the field's IDENTITY rather than on its text. The goal lives in
// React state, and state survives exactly as long as the node does — so the same
// textarea object still being there after the rows go to zero is the whole
// claim, and it is the one thing a remount could not fake.

paint('')
const typing = openTheForm()
paint('nothing-matches-this')
assert.ok(
  goalField() === typing,
  'the rows going to zero under an open form leaves the very same form standing, goal and all',
)

// Unmount at the end, as every other test that mounts this rail does: the rail's
// rows keep clocks (the shared relative-time tick, a live run's working clock,
// the git poll), and a mounted clock is a live timer, which is a process that
// never exits.
act(() => {
  root.unmount()
})

console.log('run-door new-row tests passed')
