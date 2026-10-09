// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { FileTreeRow, type FileTreeAgentMark } from './FileTree'

// A row an agent is at work on: the trail's wash, the verb on a file, the
// count on a closed folder, and the agent's own mark on the row it is on. An
// open folder says nothing, because the rows under it do.

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function mount(element: React.ReactElement): HTMLElement {
  act(() => root.render(element))
  return host.querySelector('[role="treeitem"]') as HTMLElement
}

const glyph = <span data-testid="agent" />

test('a file the agent is editing takes the stronger wash, the verb and the agent', () => {
  const mark: FileTreeAgentMark = { verb: 'editing', count: 1, glyph }
  const row = mount(<FileTreeRow name="queue.ts" isDir={false} depth={1} agentMark={mark} badge="M" />)
  expect(row.className).toContain('bg-[color:var(--agent-trail-soft-strong)]')
  const trail = row.querySelector('[data-agent-trail]') as HTMLElement
  expect(trail.dataset.agentTrail).toBe('editing')
  expect(trail.textContent).toContain('editing')
  expect(trail.querySelector('[data-testid="agent"]')).not.toBeNull()
  expect(row.textContent).toContain('an agent is editing this')
  // The git letter still trails the row, after the trail.
  expect(row.lastElementChild?.textContent).toBe('M')
})

test('a read takes the lighter wash, and a file the agent has moved on from carries no agent', () => {
  const row = mount(<FileTreeRow name="a.ts" isDir={false} depth={0} agentMark={{ verb: 'reading', count: 1 }} />)
  expect(row.className).toContain('bg-[color:var(--agent-trail-soft)]')
  expect(row.querySelector('[data-testid="agent"]')).toBeNull()
})

test('a closed folder counts the marked files under it; an open one is left alone', () => {
  const mark: FileTreeAgentMark = { verb: 'reading', count: 3, glyph }
  const closed = mount(<FileTreeRow name="src" isDir depth={0} expanded={false} agentMark={mark} />)
  expect(closed.querySelector('[data-agent-trail]')?.textContent).toContain('3')
  expect(closed.textContent).toContain('an agent is reading 3 files in here')
  const open = mount(<FileTreeRow name="src" isDir depth={0} expanded agentMark={mark} />)
  expect(open.querySelector('[data-agent-trail]')).toBeNull()
  expect(open.className).not.toContain('agent-trail')
})

test('selection wins over the wash, as it does over a role', () => {
  const row = mount(
    <FileTreeRow name="a.ts" isDir={false} depth={0} selection="cursor" agentMark={{ verb: 'editing', count: 1 }} />,
  )
  expect(row.className).not.toContain('agent-trail-soft')
  expect(row.querySelector('[data-agent-trail]')).not.toBeNull()
})
