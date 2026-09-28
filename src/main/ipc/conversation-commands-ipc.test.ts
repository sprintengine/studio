import { expect, test } from 'vitest'

import type { ConversationCommand } from '../../shared/conversation/commands'
import {
  CONVERSATION_COMMANDS_CHANGED_CHANNEL,
  CONVERSATION_COMMANDS_LIST_CHANNEL,
} from '../../shared/ipc/conversation-commands'
import { conversationCommandsFor, publishConversationCommands } from '../conversation-commands/registry'
import { createConversationCommandsService } from '../conversation-commands/service'
import { readConversationCommandsRequest, registerConversationCommandsIpc } from './conversation-commands-ipc'

type Handler = (event: unknown, raw?: unknown) => Promise<unknown>

function harness(probe: (input: { cli: string; cwd: string }) => Promise<ConversationCommand[] | null>) {
  const handlers = new Map<string, Handler>()
  const ipcMain = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) }
  const sent: Array<[string, unknown]> = []
  const window = {
    isDestroyed: () => false,
    webContents: { send: (channel: string, payload: unknown) => sent.push([channel, payload]) },
  }
  const closed = { isDestroyed: () => true, webContents: { send: () => sent.push(['closed', null]) } }
  const { stop } = registerConversationCommandsIpc(ipcMain as never, {
    service: createConversationCommandsService({ probe, now: () => 60 * 60_000 }),
    getWindows: () => [window, closed],
  })
  return { list: (raw: unknown) => handlers.get(CONVERSATION_COMMANDS_LIST_CHANNEL)!(null, raw), sent, stop }
}

test('the list answers with the cached catalog, then the refreshed one reaches every open window', async () => {
  const cwd = '/Users/dev/ipc-app'
  publishConversationCommands({ cli: 'claude-code', cwd, commands: [{ name: 'cached', source: 'cli' }], fetchedAt: 1 })
  let answer: () => void = () => undefined
  const { list, sent, stop } = harness(
    (input) =>
      new Promise((resolve) => {
        answer = () => {
          const commands: ConversationCommand[] = [{ name: 'fresh', source: 'cli' }]
          publishConversationCommands({ cli: input.cli, cwd: input.cwd, commands })
          resolve(commands)
        }
      }),
  )
  try {
    const first = (await list({ cli: 'claude-code', cwd })) as { commands: ConversationCommand[] }
    expect(first.commands.map((command) => command.name)).toEqual(['cached'])
    answer()
    expect(sent).toEqual([[CONVERSATION_COMMANDS_CHANGED_CHANNEL, conversationCommandsFor('claude-code', cwd)]])
    expect(conversationCommandsFor('claude-code', cwd).commands.map((command) => command.name)).toEqual(['fresh'])
  } finally {
    stop()
  }
})

test('a request for a CLI with no chat, or a folder that is not absolute, is refused', async () => {
  const { list, stop } = harness(async () => null)
  try {
    await expect(list({ cli: 'emacs', cwd: '/Users/dev/app' })).rejects.toThrow()
    await expect(list({ cli: 'claude-code', cwd: 'relative/app' })).rejects.toThrow()
    await expect(list(null)).rejects.toThrow()
  } finally {
    stop()
  }
  expect(readConversationCommandsRequest({ cli: 'codex', cwd: '/Users/dev/app', refresh: true, extra: 1 })).toEqual({
    cli: 'codex',
    cwd: '/Users/dev/app',
    refresh: true,
  })
})

test('a request may ask for what is held without a probe, and only with `probe: false`', () => {
  expect(readConversationCommandsRequest({ cli: 'codex', cwd: '/Users/dev/app', probe: false })).toEqual({
    cli: 'codex',
    cwd: '/Users/dev/app',
    probe: false,
  })
  expect(readConversationCommandsRequest({ cli: 'codex', cwd: '/Users/dev/app', probe: 'no' })).toEqual({
    cli: 'codex',
    cwd: '/Users/dev/app',
  })
})
