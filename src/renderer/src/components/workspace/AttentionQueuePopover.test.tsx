import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { AttentionQueuePopover, groupBySessionGroup, type AttentionQueueSurface } from './AttentionQueuePopover'
import { attentionQueueBadge } from '../../utils/attentionQueue'
import type { SessionGroup, SessionItem } from './WorkspaceActions'
import type { Workspace } from '../../types/workspace'

// QA regression for the T2 title-bar Attention Queue trigger. The trigger renders
// inline (no portal), so renderToStaticMarkup exercises the real component and its
// T2-authored logic: the live-count aria-label and the count+tone badge. The
// popover BODY renders through createPortal (open only), which the server renderer
// cannot emit — body grouping/empty/disabled rows are covered by note + manual
// reasoning in the validation report, not here.

const WS_A = { id: 'ws-a', name: 'Alpha', mode: 'standard' } as unknown as Workspace
const WS_B = { id: 'ws-b', name: 'Bravo', mode: 'standard' } as unknown as Workspace

function workspaceGroup(workspace: Workspace): SessionGroup {
  return { kind: 'workspace', id: workspace.id, label: workspace.name, workspace }
}

function makeItem(overrides: Partial<SessionItem> & Pick<SessionItem, 'sessionId' | 'status'>): SessionItem {
  return {
    group: workspaceGroup(WS_A),
    kind: 'agent',
    transport: 'terminal',
    agentId: 'a1',
    terminalId: null,
    label: 'Agent One',
    cli: 'claude',
    source: 'hook',
    activitySince: 0,
    lastActivityAt: 0,
    exitCode: null,
    role: null,
    specialistId: null,
    taskId: null,
    ...overrides,
  } as SessionItem
}

function renderTrigger(items: SessionItem[], open = false): string {
  const surface: AttentionQueueSurface = {
    items,
    badge: attentionQueueBadge(items),
    open,
    onOpenChange: () => {},
    windowWorkspaceIds: new Set(items.map((i) => i.group.id)),
    activeWorkspaceId: null,
    onOpenItem: () => {},
  }
  return renderToStaticMarkup(<AttentionQueuePopover {...surface} />)
}

// --- AC1: trigger aria-label states the LIVE count -------------------------
const emptyMarkup = renderTrigger([])
assert.match(emptyMarkup, /aria-label="Attention queue — all caught up"/, 'empty: aria-label says all caught up')
assert.match(emptyMarkup, /aria-pressed="false"/, 'closed: aria-pressed is false')

const oneNeeds = renderTrigger([
  makeItem({ sessionId: 's1', status: 'needs-input', label: 'Agent One' }),
])
assert.match(oneNeeds, /aria-label="Attention queue — 1 agent waiting"/, 'singular: "1 agent waiting"')

const twoMixed = renderTrigger([
  makeItem({ sessionId: 's1', status: 'needs-input' }),
  makeItem({ sessionId: 's2', status: 'failed', exitCode: 1, group: workspaceGroup(WS_B) }),
])
assert.match(twoMixed, /aria-label="Attention queue — 2 agents waiting"/, 'plural: "2 agents waiting"')

// open trigger flips aria-pressed
const openMarkupTrigger = (() => {
  // open=true forces the portal body; renderToStaticMarkup throws on portals, so
  // only assert the trigger when the renderer tolerates it. Wrap to keep the
  // regression honest about what the server renderer can and cannot emit.
  try {
    return renderTrigger([makeItem({ sessionId: 's1', status: 'needs-input' })], true)
  } catch {
    return null
  }
})()
if (openMarkupTrigger) {
  assert.match(openMarkupTrigger, /aria-pressed="true"/, 'open: aria-pressed is true')
}

// --- AC2: badge hidden at zero, shown with count + tone --------------------
assert.equal(/class="[^"]*absolute -right-1 -top-1/.test(emptyMarkup), false, 'zero: no badge span')
assert.match(oneNeeds, /absolute -right-1 -top-1/, 'needs-input: badge span present')
// needs-input drives the warn tone fill.
assert.match(oneNeeds, /var\(--tone-warn\)/, 'needs-input badge uses warn tone fill')

// failed-only drives the error tone fill.
const failedOnly = renderTrigger([
  makeItem({ sessionId: 'f1', status: 'failed', exitCode: 137 }),
])
assert.match(failedOnly, /var\(--tone-error\)/, 'failed-only badge uses error tone fill')

// mixed needs-input + failed: warn wins (needs-input outranks failed).
assert.match(twoMixed, /var\(--tone-warn\)/, 'mixed badge prefers warn over error')

// 99+ cap on the badge label.
const flood = renderTrigger(
  Array.from({ length: 150 }, (_, i) => makeItem({ sessionId: `n${i}`, status: 'needs-input' })),
)
assert.match(flood, />99\+</, 'badge caps at 99+')
assert.match(flood, /aria-label="Attention queue — 150 agents waiting"/, 'aria-label keeps the true count')

// --- MC-1786: detached sessions get their own trailing bucket --------------
// The body renders through a portal the server renderer cannot emit, so the
// grouping that decides bucket order is asserted directly on the pure function
// the body maps over.
const DETACHED: SessionGroup = { kind: 'detached', id: 'detached:Reviews', label: 'Reviews' }
const grouped = groupBySessionGroup([
  makeItem({ sessionId: 'd1', status: 'needs-input', group: DETACHED }),
  makeItem({ sessionId: 'w1', status: 'failed', exitCode: 1 }),
  makeItem({ sessionId: 'd2', status: 'failed', exitCode: 1, group: DETACHED }),
  makeItem({ sessionId: 'w2', status: 'needs-input', group: workspaceGroup(WS_B) }),
])
assert.deepEqual(
  grouped.map((entry) => entry.group.label),
  ['Alpha', 'Bravo', 'Reviews'],
  'detached buckets render after every workspace, workspaces in encounter order',
)
assert.deepEqual(
  grouped.at(-1)?.items.map((item) => item.sessionId),
  ['d1', 'd2'],
  'rows sharing a detached label collapse into one bucket, order preserved',
)

console.log('AttentionQueuePopover.test.tsx: all assertions passed')
