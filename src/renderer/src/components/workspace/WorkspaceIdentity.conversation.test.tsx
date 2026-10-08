import { JSDOM } from 'jsdom'
import { expect, test } from 'vitest'

// The title bar's branch chip and its two panel doors (the project toggles the
// file explorer, the branch the Git panel) step aside while the agent followed
// is a conversation: its composer strip says the branch and the changes and
// opens both panels from there (owner ruling 2026-10-04). A terminal has no
// strip, so with one followed the bar keeps everything it had.

async function mountIdentity(runtime: 'conversation' | 'terminal', extraProps: Record<string, unknown> = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  Object.assign(globalThis, globals)
  Object.assign(dom.window, {
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    api: {
      platform: 'darwin',
      getGitRepoRoot: async (path: string) => path,
      getGitBranches: async () => ({ current: 'fix/cli-update-output', branches: [] }),
      watchGitCheckout: () => () => undefined,
      getWorkspaceChangeSummary: async () => ({
        additions: 3,
        deletions: 0,
        changedFiles: 3,
        scope: 'folder',
        files: { added: 0, updated: 3, removed: 0 },
      }),
    },
  })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useWorkspaceStore } = await import('../../store/workspaceStore')
  const { WorkspaceIdentity } = await import('./WorkspaceIdentity')
  const agent =
    runtime === 'conversation'
      ? { id: 'agent', name: 'Chat', runtimeKind: 'conversation', conversation: { providerId: 'mock', modelId: 'm' } }
      : { id: 'agent', name: 'Shell agent', runtimeKind: 'terminal', cli: 'claude-code' }
  const workspace = {
    id: 'workspace',
    name: 'Project',
    folderPath: '/Users/dev/project',
    agents: { agent },
  }
  useWorkspaceStore.setState({
    workspaces: [workspace] as never,
    focusedAgentByWorkspaceId: { workspace: 'agent' } as never,
  })
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () =>
    root.render(
      createElement(WorkspaceIdentity, {
        activeWorkspace: workspace as never,
        activeWorkspaceId: 'workspace',
        ...extraProps,
      }),
    ),
  )
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  const labels = () => Array.from(host.querySelectorAll('button')).map((item) => item.getAttribute('aria-label') ?? '')
  return {
    host,
    labels,
    async unmount() {
      await act(async () => root.unmount())
      dom.window.close()
      for (const key of Object.keys(globals)) {
        if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

test('with a conversation followed, the title bar names the project and carries no branch, counts or panel doors', async () => {
  const bar = await mountIdentity('conversation')
  try {
    expect(bar.host.textContent).toContain('project')
    expect(bar.host.textContent).not.toContain('fix/cli-update-output')
    expect(bar.host.textContent).not.toContain('+3')
    expect(bar.labels().some((label) => label.startsWith('Toggle Git panel'))).toBe(false)
    expect(bar.labels().some((label) => label.startsWith('Toggle file explorer'))).toBe(false)
  } finally {
    await bar.unmount()
  }
})

test('with a terminal agent followed, the title bar keeps its branch chip, its counts and both panel doors', async () => {
  const bar = await mountIdentity('terminal')
  try {
    expect(bar.host.textContent).toContain('fix/cli-update-output')
    expect(bar.host.textContent).toContain('+3')
    expect(bar.labels().some((label) => label.startsWith('Toggle Git panel, branch fix/cli-update-output'))).toBe(true)
    expect(bar.labels()).toContain('Toggle file explorer, /Users/dev/project')
  } finally {
    await bar.unmount()
  }
})

// Label-in-name: the button shows the chat's name, so its accessible name must
// contain it — a voice user says what they see — and still say what it does.
test('the name that toggles the sidebar keeps the visible name in its accessible name', async () => {
  for (const sidebarCollapsed of [false, true]) {
    const bar = await mountIdentity('conversation', { onToggleSidebar: () => undefined, sidebarCollapsed })
    try {
      const action = sidebarCollapsed ? 'open sidebar' : 'close sidebar'
      expect(bar.labels()).toContain(`Project, ${action}`)
    } finally {
      await bar.unmount()
    }
  }
})
