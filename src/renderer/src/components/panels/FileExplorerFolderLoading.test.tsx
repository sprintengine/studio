// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test } from 'vitest'

import { FOLDER_LOADING_DELAY_MS } from '../../hooks/useSlowFolderLoads'
import type { LayoutTemplate } from '../../types/workspace'

// A folder on an SSH machine can take a second to list. The tree opens a folder
// only once its listing is in, so until then the click has to be answered some
// other way: the spinner stands in the chevron's place. A local folder lists
// faster than the hold, and its chevron never blinks.

const ROOT = '/Users/dev/app'
const DISK: Record<string, { name: string; isDir: boolean }[]> = {
  [ROOT]: [
    { name: 'remote', isDir: true },
    { name: 'local', isDir: true },
  ],
  [`${ROOT}/remote`]: [{ name: 'deploy.sh', isDir: false }],
  [`${ROOT}/local`]: [{ name: 'notes.md', isDir: false }],
}
// The slow folder's listing waits on this until the test lets it land.
let releaseRemote: (() => void) | null = null

;(window as unknown as { api: unknown }).api = new Proxy(
  {
    platform: 'darwin',
    readdir: async (path: string) => {
      if (path === `${ROOT}/remote`) await new Promise<void>((resolve) => (releaseRemote = resolve))
      const listing = DISK[path]
      if (!listing) throw new Error(`ENOENT: ${path}`)
      return listing
    },
    watchPath: async () => async () => {},
    checkWorkspaceFolder: async (path: string) => ({ ok: true, status: 'ready', path, checkedPath: path }),
    getGitRepoRoot: async () => null,
    checkIgnored: async () => [],
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
  id: 'files-loading-test',
  name: 'Files',
  description: 'Files folder loading test template',
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
  releaseRemote?.()
  releaseRemote = null
  if (root) await act(async () => root?.unmount())
  host?.remove()
})

async function settle(ms = 40): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

async function mountTree(): Promise<void> {
  const workspaceId = useWorkspaceStore.getState().addWorkspace(template, { name: 'App', folderPath: ROOT })
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
}

function row(name: string): HTMLElement {
  const match = Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]')).find(
    (item) => item.textContent?.includes(name) && item.getAttribute('aria-level') === '2',
  )
  if (!match) throw new Error(`no row ${name}`)
  return match
}

async function clickChevron(name: string): Promise<void> {
  const chevron = row(name).querySelector<HTMLButtonElement>('button[aria-label="Expand folder"]')
  await act(async () => chevron?.click())
}

test('a folder slow to list shows the spinner in its chevron’s place, then opens', async () => {
  await mountTree()
  await clickChevron('remote')

  expect(row('remote').querySelector('[aria-label="Loading folder"]'), 'not before the hold').toBeNull()
  await settle(FOLDER_LOADING_DELAY_MS + 40)
  expect(row('remote').querySelector('[aria-label="Loading folder"]')).not.toBeNull()
  expect(row('remote').getAttribute('aria-busy')).toBe('true')
  expect(row('remote').querySelector('button[aria-label="Expand folder"]')).toBeNull()

  await act(async () => releaseRemote?.())
  await settle()
  expect(row('remote').querySelector('[aria-label="Loading folder"]')).toBeNull()
  expect(row('remote').getAttribute('aria-expanded')).toBe('true')
  expect(row('remote').hasAttribute('aria-busy')).toBe(false)
  expect(document.body.textContent).toContain('deploy.sh')
})

test('a folder that lists quickly simply opens', async () => {
  await mountTree()
  await clickChevron('local')
  await settle(FOLDER_LOADING_DELAY_MS + 40)
  expect(row('local').getAttribute('aria-expanded')).toBe('true')
  expect(document.querySelector('[aria-label="Loading folder"]')).toBeNull()
})
