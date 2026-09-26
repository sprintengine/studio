import { test, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { changeTree, hasTurnChanges } from './changedFilesCard'

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
            <ChangedFilesCard turnSeq={1} summary={{ files: 1, addedLines: 1, removedLines: 1 }} running={false} />
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
