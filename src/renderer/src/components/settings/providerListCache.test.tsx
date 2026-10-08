// @vitest-environment jsdom
//
// Settings ▸ Providers draws the last launch's provider list at once and reads
// the real one behind it, rather than a second or more of a loading line.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { ConversationProviderListResult } from '../../../../shared/electron-api'
import type { ConversationProviderListEntry } from '../../../../shared/plugin-manifest'
import { ConfirmDialogProvider } from '../ui/ConfirmDialog'
import { ProviderSettingsTab } from './ProviderSettingsTab'
import { readCachedProviderList, writeCachedProviderList } from './providerSettings'

const OPENROUTER: ConversationProviderListEntry = {
  id: 'openrouter',
  displayName: 'OpenRouter',
  source: 'bundled',
  version: 1,
  providerType: 'model-provider',
  models: [{ id: 'openai/gpt-4o-mini', displayName: 'GPT-4o mini' }],
  supportsDynamicModels: true,
  credentialSource: 'api-key',
  adapter: { kind: 'declarative', execution: 'declarative', trust: 'not_required' },
}

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) }
}

test('a list main answered is kept, and read back as the same list', () => {
  const storage = memoryStorage()
  writeCachedProviderList(storage, { ok: true, providers: [OPENROUTER] })
  expect(readCachedProviderList(storage)).toEqual({ ok: true, providers: [OPENROUTER] })
})

test('a failed read keeps the last good list', () => {
  const storage = memoryStorage()
  writeCachedProviderList(storage, { ok: true, providers: [OPENROUTER] })
  writeCachedProviderList(storage, { ok: false, message: 'Provider host is starting.' })
  expect(readCachedProviderList(storage)).toEqual({ ok: true, providers: [OPENROUTER] })
})

test('nothing kept, or something that does not parse, is no list', () => {
  const storage = memoryStorage()
  expect(readCachedProviderList(storage)).toBe(null)
  expect(readCachedProviderList(null)).toBe(null)
  storage.setItem('sprintengine-provider-list-v1', '{not json')
  expect(readCachedProviderList(storage)).toBe(null)
  storage.setItem('sprintengine-provider-list-v1', JSON.stringify([{ id: 7 }]))
  expect(readCachedProviderList(storage)).toBe(null)
})

let root: Root
let host: HTMLDivElement
let answer: (result: ConversationProviderListResult) => void

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  ;(window as unknown as { api: unknown }).api = {
    conversationProvidersList: () =>
      new Promise<ConversationProviderListResult>((resolve) => {
        answer = resolve
      }),
    conversationSecretStatus: () => new Promise(() => {}),
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  localStorage.clear()
})

async function render(): Promise<void> {
  await act(async () =>
    root.render(
      <ConfirmDialogProvider>
        <ProviderSettingsTab />
      </ConfirmDialogProvider>,
    ),
  )
}

test('the remembered list is on screen at once, its keys checking, while the real one is read', async () => {
  writeCachedProviderList(localStorage, { ok: true, providers: [OPENROUTER] })
  await render()
  expect(host.textContent).toContain('OpenRouter')
  expect(host.textContent).toContain('Checking the key…')
  expect(host.textContent).not.toContain('Loading providers…')
  expect(host.querySelector('[role="status"][aria-label="Checking for changes"]')).not.toBe(null)

  await act(async () => answer({ ok: true, providers: [OPENROUTER, { ...OPENROUTER, id: 'xai', displayName: 'xAI' }] }))
  expect(host.textContent).toContain('xAI')
  expect(host.querySelector('[aria-label="Checking for changes"]')).toBe(null)
  expect(readCachedProviderList(localStorage)).toMatchObject({
    ok: true,
    providers: [{ id: 'openrouter' }, { id: 'xai' }],
  })
})

test('with nothing remembered, the tab loads as before', async () => {
  await render()
  expect(host.querySelector('[role="status"]')?.textContent).toBe('Loading providers…')
})
