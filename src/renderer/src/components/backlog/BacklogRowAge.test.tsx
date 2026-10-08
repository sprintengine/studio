import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test, vi } from 'vitest'

import type { RelativeNowClocks } from '../../hooks/useRelativeNow'

const clock = vi.hoisted(() => ({ now: 0, listeners: new Set<(now: number) => void>() }))

// The rows read the window's shared clock; this one is advanced by hand.
vi.mock('../../hooks/useRelativeNow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/useRelativeNow')>()
  const clocks: RelativeNowClocks = {
    subscribe(_intervalMs, listener) {
      clock.listeners.add(listener)
      return () => clock.listeners.delete(listener)
    },
    current: () => clock.now,
  }
  return {
    ...actual,
    relativeNowClocks: () => clocks,
    useRelativeNowFor: (labels: (now: number) => string, intervalMs?: number) =>
      actual.useRelativeNowFor(labels, intervalMs, clocks),
  }
})

test('a backlog row without a fixed clock redraws its age only when the label changes', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window as unknown as Record<string, unknown>
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

  const { act, createElement, Profiler } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { BacklogRowContent } = await import('./BacklogRow')
  const { createBacklogItem } = await import('../../utils/backlog')
  const { formatRelativeMsAgo } = await import('../../utils/relativeTime')

  const items = ['one', 'two', 'three'].map((name) =>
    createBacklogItem({
      path: `/repo/backlog/${name}.md`,
      relativePath: `backlog/${name}.md`,
      sourceContent: `# Item ${name}\n`,
      stats: { modifiedAtMs: 1_000, sizeBytes: 16 },
    }),
  )
  clock.now = 1_000 + 5 * 60_000 + 20_000
  let commits = 0
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      createElement(
        Profiler,
        { id: 'rows', onRender: () => (commits += 1) },
        items.map((item) => createElement('div', { key: item.id }, createElement(BacklogRowContent, { item }))),
      ),
    )
  })
  const expected = formatRelativeMsAgo(1_000, clock.now)
  assert.ok(container.textContent?.includes(expected), `rows read ${expected}`)
  const settled = commits

  const tick = (now: number): void => {
    clock.now = now
    act(() => {
      for (const listener of clock.listeners) listener(now)
    })
  }
  tick(clock.now + 10_000)
  assert.equal(commits, settled, 'a tick that leaves every label alone renders nothing')

  tick(1_000 + 2 * 60 * 60_000)
  assert.ok(commits > settled, 'a tick that moves the label redraws it')
  assert.ok(container.textContent?.includes(formatRelativeMsAgo(1_000, clock.now)))
  assert.ok(!container.textContent?.includes(expected))

  act(() => root.unmount())
})
