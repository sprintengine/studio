// @vitest-environment jsdom
//
// The import picker's folder rows: opening one must not move anything beside
// its toggle, and the sessions it opens end where the folder row ends.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { ConversationImportFolder } from '../../../../shared/electron-api'
import { ConversationImportPicker } from './ConversationImportPicker'

const NOW = Date.now()
const FOLDER: ConversationImportFolder = {
  folderPath: '/Users/dev/project',
  name: 'project',
  lastActiveAt: NOW - 60_000,
  sessions: [
    {
      source: 'claude-code',
      sessionId: 'one',
      title: 'Parser spans',
      folderPath: '/Users/dev/project',
      startedAt: NOW - 120_000,
      updatedAt: NOW - 60_000,
      imported: false,
    },
  ],
}

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function render(): Promise<void> {
  await act(async () =>
    root.render(
      <ConversationImportPicker
        scan={{ status: 'ready', folders: [FOLDER] }}
        selected={new Set()}
        onSelectedChange={() => {}}
      />,
    ),
  )
}

const toggle = (): HTMLButtonElement => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!

test('the folder toggle is one glyph whatever its state, so the time beside it never moves', async () => {
  await render()
  const closed = toggle()
  expect(closed.getAttribute('aria-label')).toBe('Choose sessions in project')
  expect(closed.textContent).toBe('')
  const closedClass = closed.className
  await act(async () => closed.click())
  const opened = toggle()
  expect(opened.getAttribute('aria-expanded')).toBe('true')
  expect(opened.getAttribute('aria-label')).toBe('Hide sessions in project')
  expect(opened.textContent).toBe('')
  expect(opened.className).toBe(closedClass)
})

test("a session row holds the toggle's column empty, so its time ends where the folder's does", async () => {
  await render()
  await act(async () => toggle().click())
  const row = host.querySelector('ul[aria-label="Sessions in project"] > li')!
  const last = row.lastElementChild as HTMLElement
  expect(last.getAttribute('aria-hidden')).toBe('true')
  expect(last.className).toContain('w-[var(--hit-target-min)]')
  // The toggle is the same width: the kit's xs icon step is the hit-target square.
  expect(toggle().className).toContain('size-[var(--hit-target-min)]')
})
