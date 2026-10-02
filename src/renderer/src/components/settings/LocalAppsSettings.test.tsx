// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { StudioLocalAppsStatus } from '../../../../shared/studio-local-apps'
import { ConfirmDialogProvider } from '../ui'

const { LocalAppsSettings } = await import('./LocalAppsSettings')

const base: StudioLocalAppsStatus = {
  running: true,
  socketPath: '/Users/dev/Library/Application Support/SprintEngine Studio/run/studio.sock',
  lastError: null,
  apps: [
    {
      id: 'sla_1',
      name: 'release-bot',
      scopes: ['conversation:read', 'conversation:create'],
      ceiling: 'manual',
      createdAt: '2026-10-01T09:00:00.000Z',
      lastSeenAt: null,
      toolReach: 'own',
      connected: true,
    },
  ],
  offers: [],
}

let root: Root
let host: HTMLDivElement
let status: StudioLocalAppsStatus
let push: ((next: StudioLocalAppsStatus) => void) | null
const calls: Array<[string, unknown]> = []

beforeEach(() => {
  status = structuredClone(base)
  push = null
  calls.length = 0
  Object.assign(window, {
    api: {
      studioLocalAppsStatus: vi.fn(async () => status),
      studioLocalAppsRevoke: vi.fn(async (id: string) => {
        calls.push(['revoke', id])
        return { ...status, apps: [] }
      }),
      studioLocalAppsOffer: vi.fn(async (input: unknown) => {
        calls.push(['offer', input])
        const offer = {
          id: 'slo_1',
          name: 'ci-runner',
          scopes: ['conversation:read', 'conversation:operate'],
          ceiling: 'auto',
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        }
        return { offer, code: 'sepair_abcdefghijklmnop', status: { ...status, offers: [offer] } }
      }),
      studioLocalAppsCancelOffer: vi.fn(async () => status),
      onStudioLocalAppsChanged: (cb: (next: StudioLocalAppsStatus) => void) => {
        push = cb
        return () => {
          push = null
        }
      },
      clipboardWriteText: vi.fn(async () => undefined),
    },
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function render(): Promise<void> {
  await act(async () =>
    root.render(
      <ConfirmDialogProvider>
        <LocalAppsSettings />
      </ConfirmDialogProvider>,
    ),
  )
}
const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === name,
  )
  if (!found) throw new Error(`No button "${name}"`)
  return found
}

test('each paired app shows what it may do, its ceiling and whether it is connected, in words', async () => {
  await render()
  expect(host.textContent).toContain('release-bot')
  expect(host.textContent).toContain('Connected · chats up to Manual')
  const pills = [...host.querySelectorAll('[role="group"][aria-label="What release-bot may do"] span')].map(
    (pill) => pill.textContent,
  )
  expect(pills).toEqual(['conversation:read', 'conversation:create'])
  await act(async () => push?.({ ...status, apps: [{ ...status.apps[0], connected: false }] }))
  expect(host.textContent).toContain('Not connected yet · chats up to Manual')
})

test('revoking asks first, then revokes', async () => {
  await render()
  await act(async () => button('Revoke').click())
  expect(document.body.textContent).toContain('Revoke release-bot?')
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (candidate) => candidate.textContent?.trim() === 'Revoke',
  )!
  await act(async () => confirm.click())
  expect(calls).toEqual([['revoke', 'sla_1']])
  expect(host.textContent).toContain('No apps are paired')
})

test('pairing names the app, picks scopes and a ceiling, and shows the code once', async () => {
  await render()
  await act(async () => button('Pair an app').click())
  const name = host.querySelector<HTMLInputElement>('input')!
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(name, 'ci-runner')
    name.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => button('Make pairing code').click())
  expect(calls).toEqual([
    [
      'offer',
      { name: 'ci-runner', scopes: ['conversation:read', 'conversation:operate'], ceiling: 'auto', toolReach: 'own' },
    ],
  ])
  expect(host.textContent).toContain('Pairing code for ci-runner')
  expect(host.textContent).toContain('sepair_abcdefghijklmnop')
  expect(host.textContent).toContain('Waiting to pair')
  // Redeemed elsewhere: the code is not left on screen.
  await act(async () => push?.({ ...status, offers: [] }))
  expect(host.textContent).not.toContain('sepair_abcdefghijklmnop')
})

test('a Studio that is not serving the socket shows its apps but offers no pair or revoke', async () => {
  status = {
    ...status,
    running: false,
    lastError: 'The local app socket did not start: Another Studio is already serving this data directory.',
  }
  await render()
  expect(button('Pair an app').disabled).toBe(true)
  expect(button('Revoke').disabled).toBe(true)
  expect(host.textContent).toContain('Pair and revoke apps from the Studio that is serving it.')
})
