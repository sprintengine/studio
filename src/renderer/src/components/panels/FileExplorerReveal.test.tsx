// @vitest-environment jsdom
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, test } from 'vitest'

import type { LayoutTemplate } from '../../types/workspace'

// The Files pane reveals when asked — on mount, from the toolbar, from a
// terminal link — and NOT every time the editor's active file changes. The
// reveal effect used to depend on the path it revealed, which followed the
// active file, so every tab switch re-ran it: the tree kept jumping to
// whatever was open, against its own comment. It now runs on the token alone.

const ROOT = '/Users/dev/app'
const DISK: Record<string, { name: string; isDir: boolean }[]> = {
  [ROOT]: [
    { name: 'src', isDir: true },
    { name: 'docs', isDir: true },
  ],
  [`${ROOT}/src`]: [{ name: 'index.ts', isDir: false }],
  [`${ROOT}/docs`]: [{ name: 'guide.md', isDir: false }],
}
const reads: string[] = []

;(window as unknown as { api: unknown }).api = new Proxy(
  {
    platform: 'darwin',
    readdir: async (path: string) => {
      reads.push(path)
      const listing = DISK[path]
      if (!listing) throw new Error(`ENOENT: ${path}`)
      return listing
    },
    watchPath: async () => async () => {},
    checkWorkspaceFolder: async (path: string) => ({ ok: true, status: 'ready', path, checkedPath: path }),
    getGitRepoRoot: async () => null,
    checkIgnored: async () => [],
    // The store mirrors workspace edits to main; here main just says yes.
    workspaceSyncDispatch: async () => ({ ok: true }),
  } as Record<string, unknown>,
  {
    get(target, key) {
      if (typeof key !== 'string') return undefined
      if (key in target) return target[key]
      return key.startsWith('on') ? () => () => {} : async () => undefined
    },
  },
)

const { default: FileExplorer } = await import('./FileExplorer')
const { ConfirmDialogProvider } = await import('../ui/ConfirmDialog')
const { useWorkspaceStore } = await import('../../store/workspaceStore')

const template: LayoutTemplate = {
  id: 'files-test',
  name: 'Files',
  description: 'Files reveal test template',
  previewSlots: [],
  layout: {
    global: {},
    borders: [],
    layout: { type: 'row', children: [{ type: 'tabset', weight: 100, children: [] }] },
  },
}

let root: Root | null = null
let host: HTMLDivElement | null = null

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
})

async function settle(ms = 40): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

function selectedNames(): string[] {
  return Array.from(document.querySelectorAll('[role="treeitem"][aria-selected="true"]')).map(
    (row) => row.textContent ?? '',
  )
}

test('the Files tree reveals on mount and does not follow later tab switches', async () => {
  const workspaceId = useWorkspaceStore.getState().addWorkspace(template, { name: 'App', folderPath: ROOT })
  useWorkspaceStore.getState().setActiveFile(workspaceId, `${ROOT}/src/index.ts`)

  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      <ConfirmDialogProvider>
        <FileExplorer workspaceId={workspaceId} />
      </ConfirmDialogProvider>,
    ),
  )
  await settle()

  assert.ok(
    selectedNames().some((name) => name.includes('index.ts')),
    'mount lands on the open file',
  )
  assert.ok(reads.includes(`${ROOT}/src`), 'by listing its folder')

  reads.length = 0
  await act(async () => useWorkspaceStore.getState().setActiveFile(workspaceId, `${ROOT}/docs/guide.md`))
  await settle()

  assert.ok(!reads.includes(`${ROOT}/docs`), 'a tab switch lists nothing to chase the new file')
  assert.ok(
    selectedNames().some((name) => name.includes('index.ts')),
    'and the selection stays where the person left it',
  )
})
