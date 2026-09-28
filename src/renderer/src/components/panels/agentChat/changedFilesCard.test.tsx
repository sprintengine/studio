import { test, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { changeTree, changeTreeFolders, hasTurnChanges } from './changedFilesCard'

test('only available nonempty checkpoints create a card and new files stay added', () => {
  expect(hasTurnChanges(false, { files: 1, addedLines: 2, removedLines: 0 })).toBe(false)
  expect(hasTurnChanges(true, { files: 0, addedLines: 0, removedLines: 0 })).toBe(false)
  expect(hasTurnChanges(true, undefined)).toBe(false)
  expect(hasTurnChanges(true, { files: 1, addedLines: 2, removedLines: 0 })).toBe(true)
  const tree = changeTree([
    { path: 'src/new.ts', status: 'added', addedLines: 2, removedLines: 0, binary: false },
    { path: 'README.md', status: 'modified', addedLines: 1, removedLines: 1, binary: false },
  ])
  expect(tree.map((node) => node.name)).toEqual(['src', 'README.md'])
  expect(tree[0].children[0].file?.status).toBe('added')
})

test('folders total the files under them and a chain of lone folders is one row', () => {
  const file = (path: string, addedLines: number, removedLines: number) => ({
    path,
    status: 'modified' as const,
    addedLines,
    removedLines,
    binary: false,
  })
  const tree = changeTree([
    file('src/main/ipc/a.ts', 3, 1),
    file('src/main/ipc/b.ts', 2, 0),
    file('src/main/c.ts', 1, 4),
    file('docs/deep/nested/readme.md', 5, 5),
  ])
  expect(tree.map((node) => [node.name, node.addedLines, node.removedLines])).toEqual([
    ['docs/deep/nested', 5, 5],
    ['src/main', 6, 5],
  ])
  const main = tree[1]
  expect(main.path).toBe('src/main')
  expect(main.children.map((node) => [node.name, node.addedLines, node.removedLines])).toEqual([
    ['ipc', 5, 1],
    ['c.ts', 1, 4],
  ])
  expect(changeTreeFolders(tree)).toEqual(['docs/deep/nested', 'src/main', 'src/main/ipc'])
})

test('changed files load on disclosure and the tree supports one-tab-stop navigation', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const calls: unknown[] = []
  Object.assign(dom.window, {
    api: {
      platform: 'darwin',
      conversationTurnDiff: async (input: unknown) => {
        calls.push(input)
        return {
          ok: true,
          diff: {
            files: [{ path: 'src/app.ts', status: 'modified', addedLines: 1, removedLines: 1, binary: false }],
            submodulesExcluded: true,
          },
        }
      },
    },
  })
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { ChangedFilesCard } = await import('./changedFilesCard')
  const { ConversationLinkProvider } = await import('./conversationLinks')
  const { ConfirmDialogProvider } = await import('../../ui/ConfirmDialog')
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(
        <ConfirmDialogProvider>
          <ConversationLinkProvider
            workspaceId="card-test"
            workspaceRoot="/workspace/app"
            cwd="/workspace/app"
            agentId="agent"
          >
            {/* Past the glanceable count the card starts as its summary line. */}
            <ChangedFilesCard turnSeq={1} summary={{ files: 9, addedLines: 1, removedLines: 1 }} running={false} />
          </ConversationLinkProvider>
        </ConfirmDialogProvider>,
      )
    })
    expect(calls).toHaveLength(0)
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button')!.click()
    })
    expect(calls).toHaveLength(1)
    const tree = host.querySelector<HTMLElement>('[role="tree"]')!
    expect(tree.tabIndex).toBe(0)
    expect(tree.querySelectorAll('[role="treeitem"]')).toHaveLength(2)
    await act(async () => {
      tree.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })
    expect(tree.getAttribute('aria-activedescendant')).toContain('src')
    await act(async () => {
      tree.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    expect(tree.querySelectorAll('[role="treeitem"]')).toHaveLength(1)
    await act(async () => {
      tree.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(tree.querySelectorAll('[role="treeitem"]')).toHaveLength(2)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test('a small change set shows its tree at once, with figures, folder totals and diff actions', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const opened: Array<{ params: { checkpoint: string } }> = []
  Object.assign(dom.window, {
    api: {
      platform: 'darwin',
      conversationTurnDiff: async () => ({
        ok: true,
        diff: {
          files: [
            { path: 'src/main/a.ts', status: 'modified', addedLines: 3, removedLines: 1, binary: false },
            { path: 'src/main/b.ts', status: 'added', addedLines: 4, removedLines: 0, binary: false },
            { path: 'README.md', status: 'modified', addedLines: 1, removedLines: 2, binary: false },
          ],
          submodulesExcluded: true,
        },
      }),
      openAuxWindow: async (input: { params: { checkpoint: string } }) => {
        opened.push(input)
      },
    },
  })
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { ChangedFilesCard } = await import('./changedFilesCard')
  const { ConversationLinkProvider } = await import('./conversationLinks')
  const { ConfirmDialogProvider } = await import('../../ui/ConfirmDialog')
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  const button = (label: string) =>
    Array.from(host.querySelectorAll('button')).find((item) => item.getAttribute('aria-label') === label)
  const rows = () => Array.from(host.querySelectorAll('[role="treeitem"]')).map((row) => row.getAttribute('aria-label'))
  try {
    await act(async () => {
      root.render(
        <ConfirmDialogProvider>
          <ConversationLinkProvider
            workspaceId="glance-test"
            workspaceRoot="/workspace/app"
            cwd="/workspace/app"
            agentId="agent"
          >
            <ChangedFilesCard turnSeq={2} summary={{ files: 3, addedLines: 8, removedLines: 3 }} running={false} />
          </ConversationLinkProvider>
        </ConfirmDialogProvider>,
      )
    })
    // No click: three files are shown as they stand, each folder with its total.
    expect(rows()).toEqual([
      'src/main, 7 added, 1 removed',
      'src/main/a.ts, modified, 3 added, 1 removed',
      'src/main/b.ts, added, 4 added, 0 removed',
      'README.md, modified, 1 added, 2 removed',
    ])
    expect(host.querySelector('[role="treeitem"]')?.textContent).toContain('+7−1')
    await act(async () => button('Collapse all folders')!.click())
    expect(rows()).toEqual(['src/main, 7 added, 1 removed', 'README.md, modified, 1 added, 2 removed'])
    await act(async () => button('Expand all folders')!.click())
    expect(rows()).toHaveLength(4)
    await act(async () => button('Open README.md in diff viewer')!.click())
    // The turn's diff opens on the first file in the order the tree shows.
    await act(async () => button('Open diff')!.click())
    expect(opened.map((input) => JSON.parse(input.params.checkpoint).path)).toEqual(['README.md', 'src/main/a.ts'])
    expect(JSON.parse(opened[0].params.checkpoint).turnSeq).toBe(2)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test('a revert confirms the exact files shown and asks again when they changed', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const file = (path: string) => ({ path, status: 'modified', addedLines: 1, removedLines: 0, binary: false })
  const previews = [[file('src/a.ts')], [file('src/a.ts'), file('src/b.ts')]]
  const calls: Array<{ confirmed?: boolean; files?: string[] }> = []
  Object.assign(dom.window, {
    api: {
      platform: 'darwin',
      conversationRevertToTurn: async (input: { confirmed?: boolean; files?: string[] }) => {
        calls.push(input)
        if (!input.confirmed) return { ok: true, files: previews.shift(), reverted: false }
        if (input.files?.length === 1)
          return { ok: false, changed: true, message: 'The files to restore changed since they were shown.' }
        return { ok: true, files: [], reverted: true, kept: ['dist/cache.bin'] }
      },
    },
  })
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { RevertTurnAction } = await import('./changedFilesCard')
  const { ConversationLinkProvider } = await import('./conversationLinks')
  const { ConfirmDialogProvider } = await import('../../ui/ConfirmDialog')
  const { useToastStore } = await import('../../../store/toastStore')
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  const button = (label: string) =>
    Array.from(dom.window.document.querySelectorAll('button')).find((item) => item.textContent === label)
  try {
    await act(async () => {
      root.render(
        <ConfirmDialogProvider>
          <ConversationLinkProvider
            workspaceId="revert-test"
            workspaceRoot="/workspace/app"
            cwd="/workspace/app"
            agentId="agent"
          >
            <RevertTurnAction turnSeq={4} running={false} />
          </ConversationLinkProvider>
        </ConfirmDialogProvider>,
      )
    })
    await act(async () => button('Revert to before this turn')!.click())
    expect(dom.window.document.body.textContent).toContain('Your staged changes are left as they are.')
    expect(dom.window.document.body.textContent).not.toContain('staged state')
    await act(async () => button('Revert files')!.click())
    // The refused confirmation re-shows the dialog with the new list.
    expect(dom.window.document.body.textContent).toContain('changed since they were shown')
    expect(dom.window.document.body.textContent).toContain('src/b.ts')
    await act(async () => button('Revert files')!.click())
    expect(calls.filter((call) => call.confirmed).map((call) => call.files)).toEqual([
      ['src/a.ts'],
      ['src/a.ts', 'src/b.ts'],
    ])
    const toasts = useToastStore.getState().toasts
    expect(toasts.some((toast) => toast.tone === 'warn' && toast.description?.includes('dist/cache.bin'))).toBe(true)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test('undoing a revert that later work followed says it replaces that work, and acts only once confirmed', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const calls: Array<{ turnSeq: number; undo?: boolean; confirmed?: boolean; files?: string[] }> = []
  Object.assign(dom.window, {
    api: {
      platform: 'darwin',
      conversationRevertToTurn: async (input: (typeof calls)[number]) => {
        calls.push(input)
        const files = [{ path: 'src/later.ts', status: 'modified', addedLines: 3, removedLines: 1, binary: false }]
        return input.confirmed ? { ok: true, files, reverted: true } : { ok: true, files, reverted: false }
      },
    },
  })
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { RevertTurnAction } = await import('./changedFilesCard')
  const { ConversationLinkProvider } = await import('./conversationLinks')
  const { ConfirmDialogProvider } = await import('../../ui/ConfirmDialog')
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  const button = (label: string) =>
    Array.from(dom.window.document.querySelectorAll('button')).find((item) => item.textContent === label)
  const text = () => dom.window.document.body.textContent ?? ''
  try {
    await act(async () => {
      root.render(
        <ConfirmDialogProvider>
          <ConversationLinkProvider
            workspaceId="undo-test"
            workspaceRoot="/workspace/app"
            cwd="/workspace/app"
            agentId="agent"
          >
            <RevertTurnAction turnSeq={20} running={false} reverted overwritesLaterWork />
          </ConversationLinkProvider>
        </ConfirmDialogProvider>,
      )
    })
    await act(async () => button('Undo revert')!.click())
    expect(text()).toContain('Undo this revert and replace later changes?')
    expect(text()).toContain('replacing those later changes in the files below')
    expect(text()).toContain('src/later.ts · +3 −1')
    await act(async () => button('Cancel')!.click())
    expect(calls.filter((call) => call.confirmed)).toEqual([])
    await act(async () => button('Undo revert')!.click())
    await act(async () => button('Replace later changes')!.click())
    expect(calls.filter((call) => call.confirmed)).toEqual([
      { key: expect.anything(), turnSeq: 20, undo: true, confirmed: true, files: ['src/later.ts'] },
    ])
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test('a changed file opens from the repository top level, not from a workspace inside it', async () => {
  const { changedFileLocation } = await import('./changedFilesCard')
  const asked: string[] = []
  const repoRoot = async (folder: string) => {
    asked.push(folder)
    return '/Users/dev/monorepo'
  }
  expect(await changedFileLocation('/Users/dev/monorepo/apps/web', 'apps/web/src/app.ts', repoRoot)).toBe(
    '/Users/dev/monorepo/apps/web/src/app.ts',
  )
  expect(asked).toEqual(['/Users/dev/monorepo/apps/web'])
  // Without an answer from git, the workspace root is the best guess.
  expect(await changedFileLocation('/Users/dev/app', 'src/app.ts', async () => null)).toBe('/Users/dev/app/src/app.ts')
  expect(
    await changedFileLocation('/Users/dev/app', 'src/app.ts', async () => {
      throw new Error('git is not installed')
    }),
  ).toBe('/Users/dev/app/src/app.ts')
})
