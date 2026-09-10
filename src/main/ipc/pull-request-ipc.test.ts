import assert from 'node:assert/strict'

import type { BranchPullRequest } from '../../shared/git/pull-request'
import type { IpcMain } from 'electron'

import { registerPullRequestIpc } from './pull-request-ipc'

// No Electron: the one channel is registered against a fake `ipcMain` and
// invoked the way the preload would invoke it.

type Handler = (event: unknown, ...args: unknown[]) => unknown

function fakeIpcMain(): { ipcMain: IpcMain; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>()
  const ipcMain = {
    handle(channel: string, handler: Handler) {
      handlers.set(channel, handler)
    },
  } as unknown as IpcMain
  return { ipcMain, handlers }
}

async function main(): Promise<void> {
  const asked: string[] = []
  const { ipcMain, handlers } = fakeIpcMain()
  const asksForWorkspaces: string[][] = []
  registerPullRequestIpc(ipcMain, {
    refreshPullRequestsForSession: (sessionId) => {
      asked.push(sessionId)
      // "Had a resolved checkout and asked" — the record's own answer.
      return sessionId === 'has-a-checkout'
    },
    listForWorkspaces: (workspaceIds): Record<string, BranchPullRequest[]> => {
      asksForWorkspaces.push([...workspaceIds])
      // Only conversations that have something come back, so an answer is never
      // the size of the question.
      if (!workspaceIds.includes('chat-1')) return {}
      return { 'chat-1': [{ url: 'https://github.com/acme/app/pull/93' } as BranchPullRequest] }
    },
  })

  const handler = handlers.get('pullRequest:refreshForSession')
  assert.ok(handler, 'the session channel is registered')

  // The conversation channel: a different question with a different key, for
  // the rows that have no live session to ask about (owner, 2026-09-10).
  {
    const byWorkspace = handlers.get('pullRequest:listForWorkspaces')
    assert.ok(byWorkspace, 'the conversation channel is registered')
    assert.deepEqual(
      Object.keys((await byWorkspace(null, ['chat-1', 'chat-2'])) as Record<string, unknown>),
      ['chat-1'],
      'a conversation with nothing is absent rather than present and empty',
    )
    assert.deepEqual(
      await byWorkspace(null, 'not-an-array' as unknown as string[]),
      {},
      'a malformed ask answers nothing rather than throwing at a sidebar',
    )
    assert.deepEqual(await byWorkspace(null, []), {}, 'and so does an empty one, without reaching the record')
    const before = asksForWorkspaces.length
    await byWorkspace(null, [123, null, 'chat-1'] as unknown as string[])
    assert.deepEqual(
      asksForWorkspaces[before],
      ['chat-1'],
      'malformed ids are dropped, not refused — one bad id must not lose the other answers',
    )
  }

  assert.equal(
    await handler(null, 'has-a-checkout'),
    true,
    'a session that could be asked about answers true, so a one-shot caller knows it was spent',
  )
  assert.equal(
    await handler(null, 'no-checkout-yet'),
    false,
    'and a session whose checkout has not resolved answers false, so the caller can try again',
  )

  // A malformed id never reaches the record, and never surfaces an error: a
  // hover must not be able to make the app say something went wrong.
  assert.equal(await handler(null, ''), false)
  assert.equal(await handler(null, 42), false)
  assert.equal(await handler(null, 'x'.repeat(513)), false)
  assert.equal(await handler(null, 'has\u0000null'), false)
  assert.deepEqual(asked, ['has-a-checkout', 'no-checkout-yet'], 'only well-formed ids are passed on')
}

main().then(
  () => console.log('ipc/pull-request-ipc: all assertions passed'),
  (error) => {
    console.error(error)
    process.exitCode = 1
  },
)
