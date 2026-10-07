// @vitest-environment jsdom
//
// The composer tray's line for a chat whose worktree is still installing its
// dependencies: shown while the install in the chat's folder runs, gone once
// it ends, and nothing for an install in another folder.
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { WorktreeDependencyInstallView } from '../../../../../shared/electron-api'
import { applyInstallChange, installIn, WorktreeInstallTrayRow } from './worktreeInstallRow'

function view(overrides: Partial<WorktreeDependencyInstallView> = {}): WorktreeDependencyInstallView {
  return {
    id: 'install-1',
    repoRoot: '/Users/dev/app',
    path: '/Users/dev/.sprintengine-worktrees/app/chat-k7qz',
    branch: 'agent/chat-k7qz',
    command: 'npm ci',
    reason: 'first',
    state: 'running',
    startedAt: 1,
    endedAt: null,
    lastLine: null,
    output: null,
    exitCode: null,
    ...overrides,
  }
}

let root: Root | null = null
let host: HTMLElement | null = null
let listeners: Array<(view: WorktreeDependencyInstallView) => void> = []
let running: WorktreeDependencyInstallView[] = []

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  listeners = []
  running = []
  ;(window as unknown as { api: unknown }).api = {
    onWorktreeInstallChanged: (cb: (view: WorktreeDependencyInstallView) => void) => {
      listeners.push(cb)
      return () => {
        listeners = listeners.filter((listener) => listener !== cb)
      }
    },
    listWorktreeInstalls: async () => running,
  }
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
})

async function render(node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(node))
  return host
}

async function emit(next: WorktreeDependencyInstallView): Promise<void> {
  await act(async () => {
    for (const listener of listeners) listener(next)
  })
}

test('the running installs track a change: added, moved on, and dropped once it ends', () => {
  const started = applyInstallChange([], view())
  expect(started).toHaveLength(1)
  const moved = applyInstallChange(started, view({ lastLine: 'added 12 packages' }))
  expect(moved).toEqual([view({ lastLine: 'added 12 packages' })])
  expect(applyInstallChange(moved, view({ state: 'failed', endedAt: 2 }))).toEqual([])
})

test('an install is the chat’s when it runs in the folder the chat works in, however the path is spelled', () => {
  const installs = [view()]
  expect(installIn(installs, '/Users/dev/.sprintengine-worktrees/app/chat-k7qz/')).not.toBeNull()
  expect(installIn(installs, '/Users/dev/app')).toBeNull()
  expect(installIn(installs, null)).toBeNull()
})

test('the tray says the worktree is installing while it runs, with its last line, and stops once it ends', async () => {
  const shown = await render(<WorktreeInstallTrayRow folder="/Users/dev/.sprintengine-worktrees/app/chat-k7qz" />)
  expect(shown.textContent).toBe('')

  await emit(view({ lastLine: 'added 12 packages' }))
  expect(shown.textContent).toContain('Installing this worktree’s dependencies (npm ci)')
  expect(shown.textContent).toContain('added 12 packages')

  await emit(view({ state: 'succeeded', endedAt: 2 }))
  expect(shown.textContent).toBe('')
})

test('an install already running when the chat opens is shown, and one in another folder is not', async () => {
  running = [view(), view({ id: 'install-2', path: '/Users/dev/.sprintengine-worktrees/app/other' })]
  const shown = await render(<WorktreeInstallTrayRow folder="/Users/dev/.sprintengine-worktrees/app/other" />)
  expect(shown.querySelectorAll('[role="status"]')).toHaveLength(1)
  const elsewhere = await render(<WorktreeInstallTrayRow folder="/Users/dev/app" />)
  expect(elsewhere.textContent).toBe('')
})
