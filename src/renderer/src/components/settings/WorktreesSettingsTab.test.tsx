// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { WorktreeInventory, WorktreeInventoryInput } from '../../../../shared/ipc/worktree-pool'

const GB = 1024 ** 3
const now = Date.now()
const REPO = '/code/app'
const POOL = '/code/.sprintengine-worktrees/app'

const fixtures = vi.hoisted(() => ({
  state: { workspaces: [] as unknown[] },
}))
vi.mock('../../store/workspaceStore', () => {
  const useWorkspaceStore = (select: (state: typeof fixtures.state) => unknown) => select(fixtures.state)
  useWorkspaceStore.getState = () => fixtures.state
  return { useWorkspaceStore }
})

const { WorktreesSettingsTab } = await import('./WorktreesSettingsTab')
const { ConfirmDialogProvider } = await import('../ui')

const size = (bytes: number) => ({ bytes, measuredAt: now, parts: [{ name: 'node_modules', bytes }] })
const baseSlot = {
  baseRef: 'origin/main',
  baseSha: 'a41c9e2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  error: null,
  lease: null,
  held: null,
  uses: 2,
  lastBranch: null,
}
const inventory: WorktreeInventory = {
  measuredAt: now,
  projects: [
    {
      repoRoot: REPO,
      defaultRef: 'origin/main',
      error: null,
      pool: {
        poolId: 'p1',
        repoRoot: REPO,
        containerPath: POOL,
        heldByOtherInstance: false,
        defaultRef: 'origin/main',
        lastFetchAt: now,
        slots: [
          {
            ...baseSlot,
            id: 'pool-01',
            path: `${POOL}/pool-01`,
            state: 'leased',
            lease: {
              leaseId: 'l1',
              branch: 'agent/fix-login',
              owner: 'a',
              agentId: null,
              workspaceId: null,
              leasedAt: now,
            },
            lastUsedAt: now,
            size: size(2 * GB),
          },
          {
            ...baseSlot,
            id: 'pool-02',
            path: `${POOL}/pool-02`,
            state: 'held',
            held: { reason: 'dirty', detail: null, changedPaths: 1, branch: 'agent/copy', since: now },
            lastUsedAt: now,
            size: size(GB),
          },
          {
            ...baseSlot,
            id: 'pool-03',
            path: `${POOL}/pool-03`,
            state: 'idle',
            lastUsedAt: now - 1000,
            size: size(GB),
          },
          {
            ...baseSlot,
            id: 'pool-04',
            path: `${POOL}/pool-04`,
            state: 'idle',
            lastUsedAt: now - 9000,
            size: size(GB),
          },
        ],
      },
      worktrees: [
        {
          path: '/code/by-hand',
          branch: 'feat/merged',
          head: 'f00',
          slotId: null,
          lockedByOther: false,
          missing: false,
          uniqueCommits: 0,
          behindCommits: 0,
          merged: true,
          changedPaths: 0,
          changes: [],
          size: size(3 * GB),
        },
      ],
    },
  ],
}

let root: Root
let host: HTMLDivElement
const calls: { inventory: WorktreeInventoryInput[]; actions: unknown[]; removed: unknown[] } = {
  inventory: [],
  actions: [],
  removed: [],
}
const opened: string[] = []

beforeEach(() => {
  calls.inventory.length = 0
  calls.actions.length = 0
  calls.removed.length = 0
  opened.length = 0
  fixtures.state.workspaces = [
    { id: 'w1', name: 'Fix the login redirect loop', folderPath: `${POOL}/pool-01`, agents: {} },
  ]
  Object.assign(window, {
    api: {
      getWorktreeInventory: async (input: WorktreeInventoryInput) => {
        calls.inventory.push(input)
        return inventory
      },
      getWorktreePoolSettings: async () => ({ enabled: true, keepIdle: 3, maxSlots: 12, diskLimitGb: 30 }),
      setWorktreePoolSettings: async (patch: object) => ({
        enabled: true,
        keepIdle: 3,
        maxSlots: 12,
        diskLimitGb: 30,
        ...patch,
      }),
      onWorktreePoolChanged: () => () => {},
      worktreePoolAction: async (input: unknown) => {
        calls.actions.push(input)
        return { ok: true, message: null }
      },
      removeGitWorktree: async (input: unknown) => {
        calls.removed.push(input)
        return { ok: true, data: { ok: true, stdout: '', stderr: '' }, message: null }
      },
      pruneGitWorktrees: async () => ({ ok: true, data: {}, message: null }),
      showItemInFolder: async () => {},
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

async function render(): Promise<void> {
  await act(async () =>
    root.render(
      <ConfirmDialogProvider>
        <WorktreesSettingsTab onOpenChat={(id) => opened.push(id)} />
      </ConfirmDialogProvider>,
    ),
  )
  // The first read, then the measured one.
  await act(async () => {
    await Promise.resolve()
  })
}

const rowNamed = (name: string) =>
  [...host.querySelectorAll<HTMLTableRowElement>('tbody tr')].find((tr) => tr.textContent?.startsWith(name)) ?? null

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label,
  )
  if (!found) throw new Error(`no button ${label}`)
  return found
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click()
  })
}

test('reads what is known, then measures, and shows every worktree with who has it', async () => {
  await render()
  expect(calls.inventory.map((input) => input.measure)).toEqual([false, true])
  expect(calls.inventory[0].repoRoots).toEqual([REPO])
  expect(host.textContent).toContain('Worktrees')
  expect(host.textContent).toContain('8.0 GB')
  expect(rowNamed('pool-01')?.textContent).toContain('Fix the login redirect loop')
  expect(rowNamed('pool-02')?.textContent).toContain('Holding work')
  expect(rowNamed('by-hand')?.textContent).toContain('Merged')

  await click(button(rowNamed('pool-01')!, 'Open chat'))
  expect(opened).toEqual(['w1'])
})

test('Remove on a ready slot asks, then removes it through the pool', async () => {
  await render()
  await click(button(rowNamed('pool-03')!, 'Remove'))
  const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
  expect(dialog?.textContent).toContain('Remove pool-03?')
  const confirm = button(dialog!, 'Remove')
  await click(confirm)
  expect(calls.actions).toEqual([{ kind: 'evict', repoRoot: REPO, slotId: 'pool-03' }])
})

test('Free up space removes the extra ready slot and the merged worktree, keeping the newest ready one', async () => {
  await render()
  await click(button(host, 'Free up space…'))
  const free = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
    candidate.textContent?.startsWith('Free 4.0 GB'),
  )
  expect(free).toBeTruthy()
  await click(free!)
  expect(calls.actions).toEqual([{ kind: 'evict', repoRoot: REPO, slotId: 'pool-04' }])
  expect(calls.removed).toEqual([{ repoRoot: REPO, path: '/code/by-hand' }])
})

test('Free up space keeps what the person unticked when the page reads the worktrees again', async () => {
  let poolChanged: (() => void) | null = null
  Object.assign((window as unknown as { api: object }).api, {
    onWorktreePoolChanged: (cb: () => void) => {
      poolChanged = cb
      return () => {}
    },
  })
  await render()
  await click(button(host, 'Free up space…'))
  const mergedRow = [...document.body.querySelectorAll<HTMLLabelElement>('[role="dialog"] label')].find((label) =>
    label.textContent?.includes('whose branch is merged'),
  )
  await click(mergedRow!.querySelector('input')!)
  // A slot moves somewhere: the page reads again, a moment later.
  await act(async () => {
    poolChanged?.()
    await new Promise((resolve) => setTimeout(resolve, 450))
  })
  const free = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
    candidate.textContent?.startsWith('Free 1.0 GB'),
  )
  expect(free).toBeTruthy()
  await click(free!)
  expect(calls.actions).toEqual([{ kind: 'evict', repoRoot: REPO, slotId: 'pool-04' }])
  expect(calls.removed).toEqual([])
})

test('Prune says what git did: a missing worktree locked by hand is kept, and the page says so', async () => {
  const gone = {
    ...inventory.projects[0].worktrees[0],
    path: '/code/gone-by-hand',
    branch: 'feat/gone',
    missing: true,
    size: null,
  }
  Object.assign((window as unknown as { api: object }).api, {
    getWorktreeInventory: async () => ({
      ...inventory,
      projects: [{ ...inventory.projects[0], worktrees: [...inventory.projects[0].worktrees, gone] }],
    }),
    listGitWorktrees: async () => ({
      ok: true,
      data: {
        repoRoot: REPO,
        updatedAt: now,
        worktrees: [{ path: '/code/gone-by-hand', locked: true, lockedReason: 'on a USB drive' }],
      },
      message: null,
    }),
  })
  await render()
  await click(button(rowNamed('gone-by-hand')!, 'Prune'))
  expect(host.textContent).toContain('Git kept gone-by-hand: it is locked (on a USB drive)')
  expect(host.textContent).not.toContain('Git forgot')
})
