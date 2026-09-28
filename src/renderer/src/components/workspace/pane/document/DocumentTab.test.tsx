// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { WorkspacePaneTab } from '../../../../types/workspace'
import { DocumentTab } from './DocumentTab'

// The filesystem, standing in for the main process: what each path holds, and
// which paths were read.
const files = new Map<string, string>()
const reads: string[] = []

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  files.clear()
  reads.length = 0
  ;(window as unknown as { api: unknown }).api = {
    readfile: async (path: string) => {
      reads.push(path)
      const content = files.get(path)
      if (content === undefined) throw new Error('ENOENT: no such file or directory')
      return content
    },
  }
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
})

const PATH = '/Users/dev/.claude/plans/quiet-otter.md'
const tab: WorkspacePaneTab = { id: 'd1', kind: 'document', title: 'Ship the pane', document: { path: PATH } }

async function render(active: boolean): Promise<HTMLElement> {
  host ??= document.body.appendChild(document.createElement('div'))
  root ??= createRoot(host)
  await act(async () => root!.render(<DocumentTab tab={tab} active={active} />))
  return host
}

test('the document renders as markdown under its title and path', async () => {
  files.set(PATH, '# Ship the pane\n\n## Context\n\n- **One** step')
  const view = await render(true)
  expect(view.textContent).toContain('Ship the pane')
  expect(view.textContent).toContain(PATH)
  // The header's title is a heading of its own; the document's follow it.
  expect([...view.querySelectorAll('h2')].map((node) => node.textContent)).toContain('Context')
  expect(view.querySelector('li strong')?.textContent).toBe('One')
  expect(view.querySelector('[aria-label="Copy markdown"]')).not.toBeNull()
})

test('the file is read again when the tab comes back to the front', async () => {
  files.set(PATH, '# First')
  await render(true)
  await render(false)
  files.set(PATH, '# Revised')
  const view = await render(true)
  expect(reads).toEqual([PATH, PATH])
  expect(view.querySelector('h1')?.textContent).toBe('Revised')
})

test('a file that cannot be read says so, naming the path', async () => {
  const view = await render(true)
  expect(view.textContent).toContain("Couldn't open this document.")
  expect(view.textContent).toContain('ENOENT')
  expect(view.textContent).toContain(PATH)
})
