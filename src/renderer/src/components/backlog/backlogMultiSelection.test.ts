import assert from 'node:assert/strict'
import {
  collapseBacklogSelectionTo,
  effectiveBacklogSelection,
  extendBacklogSelectionTo,
  isBacklogMultiSelectionActive,
  pruneBacklogSelection,
  toggleBacklogSelection,
  EMPTY_BACKLOG_MULTI_SELECTION,
  type BacklogMultiSelection,
} from './backlogMultiSelection'

// MC-2060 (backlog multi-select). The pure selection model shared by the
// Backlog door rail and the per-project BacklogPanel: plain/cmd/shift click
// semantics, shift+arrow range stepping, the pinned cross-project collapse
// rule, and pruning across re-scans. The React wiring (which gesture maps to
// which call, paint, detail binding) lives in the two surfaces.

const ORDER = ['a1', 'a2', 'a3', 'a4', 'b1', 'b2']
// The door's cross-project list: keys a* belong to project A, b* to project B.
const projectOf = (key: string): string => key[0]

function keys(state: BacklogMultiSelection): string[] {
  return [...(state.keys ?? [])].sort()
}

// ── plain click collapses to single ─────────────────────────────────────────
{
  const state = collapseBacklogSelectionTo('a2')
  assert.equal(state.keys, null, 'plain click leaves multi mode')
  assert.equal(state.anchorKey, 'a2', 'plain click anchors the clicked row')
  assert.deepEqual(
    [...effectiveBacklogSelection(state, 'a2')],
    ['a2'],
    'single mode selects the cursor row alone',
  )
  assert.equal(isBacklogMultiSelectionActive(state), false)
}

// ── cmd-click toggles, starting from the cursor row ─────────────────────────
{
  let state = EMPTY_BACKLOG_MULTI_SELECTION
  state = toggleBacklogSelection(state, 'a1', 'a3', projectOf)
  assert.deepEqual(keys(state), ['a1', 'a3'], 'first toggle keeps the cursor row selected')
  assert.equal(state.anchorKey, 'a3', 'the toggled row becomes the anchor')
  assert.equal(isBacklogMultiSelectionActive(state), true)

  state = toggleBacklogSelection(state, 'a3', 'a1', projectOf)
  assert.deepEqual(keys(state), ['a3'], 'toggling a selected row removes it')
  assert.equal(state.keys?.size, 1, 'multi mode persists at one row (no re-select flicker)')
  assert.equal(isBacklogMultiSelectionActive(state), false)

  state = toggleBacklogSelection(state, 'a1', 'a3', projectOf)
  assert.deepEqual(keys(state), [], 'the set may empty without leaving multi mode')
  assert.deepEqual([...effectiveBacklogSelection(state, 'a3')], [], 'an emptied set selects nothing')
}

// ── shift-click ranges from the anchor over list order ──────────────────────
{
  let state = collapseBacklogSelectionTo('a2')
  state = extendBacklogSelectionTo(state, 'a2', 'a4', ORDER, projectOf)
  assert.deepEqual(keys(state), ['a2', 'a3', 'a4'], 'range is inclusive of both ends')
  assert.equal(state.anchorKey, 'a2', 'the anchor stays for the next range')

  state = extendBacklogSelectionTo(state, 'a4', 'a1', ORDER, projectOf)
  assert.deepEqual(keys(state), ['a1', 'a2'], 'a second shift re-ranges from the SAME anchor')

  // shift+↓ stepping: extend to the next row, then back — the range shrinks.
  state = extendBacklogSelectionTo(collapseBacklogSelectionTo('a2'), 'a2', 'a3', ORDER, projectOf)
  state = extendBacklogSelectionTo(state, 'a3', 'a4', ORDER, projectOf)
  assert.deepEqual(keys(state), ['a2', 'a3', 'a4'], 'shift+down twice grows from the anchor')
  state = extendBacklogSelectionTo(state, 'a4', 'a3', ORDER, projectOf)
  assert.deepEqual(keys(state), ['a2', 'a3'], 'shift+up steps the range back')
}

// ── the pinned cross-project rule: a foreign row collapses the selection ────
{
  const base = extendBacklogSelectionTo(collapseBacklogSelectionTo('a2'), 'a2', 'a3', ORDER, projectOf)
  const shiftAcross = extendBacklogSelectionTo(base, 'a3', 'b2', ORDER, projectOf)
  assert.equal(shiftAcross.keys, null, 'shift-click on another project collapses…')
  assert.equal(shiftAcross.anchorKey, 'b2', '…to the clicked row')

  const cmdAcross = toggleBacklogSelection(base, 'a3', 'b1', projectOf)
  assert.equal(cmdAcross.keys, null, 'cmd-click on another project collapses too')
  assert.equal(cmdAcross.anchorKey, 'b1')

  // Even a same-project range can only ever hold that project's rows when the
  // sort interleaves projects (the door's flat "All projects" list).
  const interleaved = ['a1', 'b1', 'a2', 'b2', 'a3']
  const ranged = extendBacklogSelectionTo(collapseBacklogSelectionTo('a1'), 'a1', 'a3', interleaved, projectOf)
  assert.deepEqual(keys(ranged), ['a1', 'a2', 'a3'], 'interleaved foreign rows never join the range')
}

// ── pruning across re-scans / lens changes ───────────────────────────────────
{
  const state = extendBacklogSelectionTo(collapseBacklogSelectionTo('a1'), 'a1', 'a3', ORDER, projectOf)
  const pruned = pruneBacklogSelection(state, new Set(['a1', 'a3', 'b1']))
  assert.deepEqual(keys(pruned), ['a1', 'a3'], 'vanished rows drop out')
  assert.equal(pruned.anchorKey, 'a1', 'a surviving anchor stays')

  const gone = pruneBacklogSelection(state, new Set(['b1']))
  assert.equal(gone.keys, null, 'a fully vanished selection collapses to single mode')
  assert.equal(gone.anchorKey, null)

  assert.equal(pruneBacklogSelection(state, new Set(ORDER)), state, 'no change returns the same state')
}

console.log('backlogMultiSelection tests passed')
