import { expect, test } from 'vitest'

import type { IpcMain } from 'electron'
import { createMainKernel } from './main-host'
import { createChatRuntimeLister } from './module-chat-runtimes'
import { ChatRuntimesToken } from './service-tokens'

const ipcMain = { handle: () => undefined, removeHandler: () => undefined } as unknown as IpcMain

test('the chat runtimes are the conversational CLIs, with availability, models and the last choice', async () => {
  const asked: string[] = []
  const list = createChatRuntimeLister({
    listClis: () => [
      { id: 'claude-code', displayName: 'Claude Code' },
      { id: 'gemini', displayName: 'Gemini' },
      { id: 'codex', displayName: 'Codex' },
      { id: 'cursor', displayName: 'Cursor' },
    ],
    availability: async () => ({ 'claude-code': { installed: true }, codex: { installed: false } }),
    modelCatalog: async (providerId) => {
      asked.push(providerId)
      return providerId === 'claude-agent'
        ? { options: [{ id: 'claude-haiku-4-5', label: 'Haiku 4.5' }, { id: 'opus' }] }
        : null
    },
    lastSelectedCli: () => 'codex',
  })
  expect(await list()).toEqual([
    {
      id: 'claude-code',
      label: 'Claude Code',
      available: true,
      models: [
        { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
        { id: 'opus', label: 'opus' },
      ],
      lastSelected: false,
    },
    // Gemini has no chat runtime and is not listed.
    { id: 'codex', label: 'Codex', available: false, models: [], lastSelected: true },
    // A CLI the probe could not answer for counts as there, as the window's list reads it.
    { id: 'cursor', label: 'Cursor', available: true, models: [], lastSelected: false },
  ])
  expect(asked).toEqual(['claude-agent', 'codex-agent', 'cursor-agent'])
})

test('a probe or catalog that fails leaves the rows, not the call, without an answer', async () => {
  const list = createChatRuntimeLister({
    listClis: () => [{ id: 'claude-code', displayName: 'Claude Code' }],
    availability: async () => {
      throw new Error('probe failed')
    },
    modelCatalog: async () => {
      throw new Error('catalog failed')
    },
    lastSelectedCli: () => null,
  })
  expect(await list()).toEqual([
    { id: 'claude-code', label: 'Claude Code', available: true, models: [], lastSelected: false },
  ])
})

test('MainHost.listChatRuntimes answers from the agent runtime module, and with nothing before it provides one', async () => {
  const kernel = createMainKernel(ipcMain)
  const host = kernel.hostFor('acme')
  expect(await host.listChatRuntimes()).toEqual([])
  kernel.hostFor('agent-runtime').provideService(ChatRuntimesToken, () => async () => [
    { id: 'codex', label: 'Codex', available: true, models: [], lastSelected: true },
  ])
  expect(await host.listChatRuntimes()).toEqual([
    { id: 'codex', label: 'Codex', available: true, models: [], lastSelected: true },
  ])
  expect(host.supports('chat-runtimes')).toBe(true)
})
