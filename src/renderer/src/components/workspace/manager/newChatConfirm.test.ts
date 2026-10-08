import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'

import { launchSettingsClient } from '../../../store/launchSettingsClient'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import type { NewChatWorktreeResult } from '../../../utils/newChatWorktree'
import { confirmNewChatWith, type NewChatConfirmHost } from './newChatConfirm'

const PROJECT = '/Users/dev/app'
const WORKTREE = '/Users/dev/.sprintengine-worktrees/app/chat-ab12'

afterEach(() => {
  vi.restoreAllMocks()
})

// A host whose starts each create a chat, and whose project use is the store's
// own, so the assertion is on what reaches main: the `projectUse` patch.
function harness(worktree: NewChatWorktreeResult = { ok: false, message: 'unused' }) {
  const updates: unknown[] = []
  vi.spyOn(launchSettingsClient, 'update').mockImplementation(async (patch) => {
    updates.push(patch)
    return true
  })
  const started: Array<{ kind: string; folderPath: string | null }> = []
  const opened: Array<{ worktree: unknown; pending: unknown }> = []
  const prepared: string[] = []
  let worktreesMade = 0
  let closed = 0
  const host: NewChatConfirmHost = {
    makeExtension: async (parentDir, id) => `${parentDir}/${id}`,
    makeWorktree: async () => {
      worktreesMade += 1
      return worktree
    },
    prepareWorktree: (workspaceId) => {
      prepared.push(workspaceId)
    },
    startTerminal: (folderPath) => {
      started.push({ kind: 'terminal', folderPath })
      return 'ws-terminal'
    },
    startGeneral: (_confirm, folderPath) => {
      started.push({ kind: 'general', folderPath })
      return 'ws-general'
    },
    startConversation: (_confirm, folderPath, _prompt, worktree, _images, _files, _background, pending) => {
      started.push({ kind: 'conversation', folderPath })
      opened.push({ worktree, pending })
      return 'ws-conversation'
    },
    recordProjectUse: (folder) => useWorkspaceStore.getState().recordProjectUse(folder),
    closePanel: () => {
      closed += 1
    },
  }
  const projectUses = () =>
    updates
      .map((patch) => (patch as { projectUse?: { folderPath: string } }).projectUse?.folderPath)
      .filter((folder): folder is string => folder !== undefined)
  return {
    host,
    started,
    opened,
    prepared,
    projectUses,
    closed: () => closed,
    worktreesMade: () => worktreesMade,
  }
}

const CHAT_CONFIRM = {
  kind: 'conversation' as const,
  provider: { providerId: 'claude', modelId: 'default', modelLabel: 'Claude' },
}

test('a chat on a worktree opens at once, folderless and waiting on its worktree', async () => {
  const { host, started, opened, prepared, projectUses, closed, worktreesMade } = harness()
  const created = await confirmNewChatWith(host, {
    confirm: { ...CHAT_CONFIRM, worktree: { name: 'fix-login' } },
    scopedFolder: PROJECT,
    startupPrompt: 'fix the login',
    hostId: 'wsl:Ubuntu',
  })
  assert.equal(created, 'ws-conversation')
  assert.equal(worktreesMade(), 0, 'the door waits on no worktree')
  assert.deepEqual(started, [{ kind: 'conversation', folderPath: null }], 'no folder until the worktree lands')
  assert.deepEqual(opened, [
    {
      worktree: { repoRoot: PROJECT },
      pending: { name: 'fix-login', projectFolder: PROJECT, hostId: 'wsl:Ubuntu' },
    },
  ])
  assert.deepEqual(prepared, ['ws-conversation'], 'the worktree is made behind the open chat')
  assert.deepEqual(projectUses(), [PROJECT])
  assert.equal(closed(), 1)
})

test('a chat on a worktree started from inside another worktree waits on a worktree of the project', async () => {
  const { host, opened } = harness()
  await confirmNewChatWith(host, {
    confirm: { ...CHAT_CONFIRM, worktree: { name: '' } },
    scopedFolder: WORKTREE,
  })
  assert.deepEqual(opened[0]?.pending, { name: '', projectFolder: PROJECT })
})

test('a conversation, a terminal agent and a plain terminal each count once as a use of the project', async () => {
  for (const confirm of [
    { kind: 'conversation' as const, provider: { providerId: 'claude', modelId: 'default', modelLabel: 'Claude' } },
    { kind: 'general' as const, cli: 'claude-code' },
    { kind: 'terminal' as const },
  ]) {
    const { host, started, projectUses, closed } = harness()
    const created = await confirmNewChatWith(host, { confirm, scopedFolder: PROJECT })
    assert.equal(created, `ws-${confirm.kind}`)
    assert.deepEqual(started, [{ kind: confirm.kind, folderPath: PROJECT }])
    assert.deepEqual(projectUses(), [PROJECT], `${confirm.kind}: one projectUse patch, for the project`)
    assert.equal(closed(), 1)
    vi.restoreAllMocks()
  }
})

test('a chat on a worktree counts the checkout it was cut from, not the worktree', async () => {
  const { host, started, projectUses } = harness({
    ok: true,
    folderPath: WORKTREE,
    worktree: { branch: 'agent/chat-ab12', repoRoot: PROJECT },
  })
  await confirmNewChatWith(host, {
    confirm: { kind: 'general', cli: 'claude-code', worktree: { name: '' } },
    scopedFolder: PROJECT,
  })
  assert.deepEqual(started, [{ kind: 'general', folderPath: WORKTREE }])
  assert.deepEqual(projectUses(), [PROJECT])
})

test('a worktree that could not be made starts nothing, counts nothing and leaves the door open', async () => {
  const { host, started, projectUses, closed } = harness({ ok: false, message: 'fetch timed out' })
  const created = await confirmNewChatWith(host, {
    confirm: { kind: 'general', cli: 'claude-code', worktree: { name: '' } },
    scopedFolder: PROJECT,
    startupPrompt: 'fix the login',
  })
  assert.equal(created, null, 'null hands the prompt back to the panel')
  assert.deepEqual(started, [])
  assert.deepEqual(projectUses(), [])
  assert.equal(closed(), 0)
})

test('a chat started in the background counts too, and keeps New chat up', async () => {
  const { host, projectUses, closed } = harness()
  await confirmNewChatWith(host, { confirm: { kind: 'terminal' }, scopedFolder: PROJECT, background: true })
  assert.deepEqual(projectUses(), [PROJECT])
  assert.equal(closed(), 0)
})

test('a chat with no project counts as no project use', async () => {
  const { host, projectUses } = harness()
  await confirmNewChatWith(host, { confirm: { kind: 'terminal' }, scopedFolder: null })
  assert.deepEqual(projectUses(), [])
})
