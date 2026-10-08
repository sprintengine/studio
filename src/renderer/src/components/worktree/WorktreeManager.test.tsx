// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const REPO = '/code/app'
const SLOT = '/code/.sprintengine-worktrees/app/pool-01'
const HEAD = 'a41c9e2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

const fixtures = vi.hoisted(() => ({
  state: {
    workspaces: [{ id: 'w1', worktreeState: { entries: {}, containerPath: null } }] as unknown[],
    workspaceWindows: [] as unknown[],
    primaryWorkspaceWindowId: null,
    setWorkspaceWorktreeState: () => {},
    upsertWorktreeEntry: () => {},
    removeWorktreeEntry: () => {},
    addWorkspace: () => {},
    setActiveWorkspaceForWindow: () => {},
  },
}))
vi.mock('../../store/workspaceStore', () => {
  const useWorkspaceStore = (select: (state: typeof fixtures.state) => unknown) => select(fixtures.state)
  useWorkspaceStore.getState = () => fixtures.state
  return { useWorkspaceStore }
})

const { default: WorktreeManager } = await import('./WorktreeManager')
const { ConfirmDialogProvider } = await import('../ui')

let root: Root
let host: HTMLDivElement
const actions: unknown[] = []

const listed = (path: string, branch: string | null) => ({
  path,
  head: HEAD,
  branch,
  branchRef: branch ? `refs/heads/${branch}` : null,
  detached: branch === null,
  bare: false,
  locked: false,
  lockedReason: null,
  prunable: false,
  prunableReason: null,
})

beforeEach(() => {
  actions.length = 0
  Object.assign(window, {
    api: {
      listGitWorktrees: async () => ({
        ok: true,
        data: { repoRoot: REPO, worktrees: [listed(REPO, 'main'), listed(SLOT, null)], updatedAt: 0 },
        message: null,
      }),
      pathExists: async () => true,
      getGitStatus: async () => ({ files: {} }),
      getWorktreePoolSnapshot: async () => ({
        poolId: 'p1',
        repoRoot: REPO,
        containerPath: '/code/.sprintengine-worktrees/app',
        heldByOtherInstance: false,
        defaultRef: 'origin/main',
        lastFetchAt: null,
        slots: [
          {
            id: 'pool-01',
            path: SLOT,
            state: 'idle',
            baseRef: 'origin/main',
            baseSha: HEAD,
            error: null,
            lease: null,
            held: null,
            lastUsedAt: 0,
            uses: 1,
            lastBranch: null,
            size: null,
            kept: null,
          },
        ],
      }),
      onWorktreePoolChanged: () => () => {},
      worktreePoolAction: async (input: unknown) => {
        actions.push(input)
        return { ok: true, message: null }
      },
    },
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click()
  })
}

function byText(scope: ParentNode, selector: string, text: string): HTMLElement {
  const found = [...scope.querySelectorAll<HTMLElement>(selector)].find((candidate) =>
    candidate.textContent?.trim().startsWith(text),
  )
  if (!found) throw new Error(`no ${selector} "${text}"`)
  return found
}

test('removing a ready slot from the pool asks first, as Settings does', async () => {
  await act(async () =>
    root.render(
      <ConfirmDialogProvider>
        <WorktreeManager
          workspaceId="w1"
          repoRoot={REPO}
          projectRoot={REPO}
          currentBranch="main"
          branchOptions={[]}
          onChanged={async () => {}}
        />
      </ConfirmDialogProvider>,
    ),
  )
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await click(host.querySelector<HTMLElement>(`[aria-label="Actions for worktree ${HEAD.slice(0, 8)}"]`)!)
  await click(byText(document.body, '[role="menuitem"]', 'Remove from the worktree pool'))
  const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
  expect(dialog?.textContent).toContain('Remove pool-01?')
  expect(actions).toEqual([])
  await click(byText(dialog!, 'button', 'Remove'))
  expect(actions).toEqual([{ kind: 'evict', repoRoot: REPO, slotId: 'pool-01' }])
})
