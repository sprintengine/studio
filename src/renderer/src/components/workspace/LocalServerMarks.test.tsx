// @vitest-environment jsdom
//
// Where the local servers agents started are seen: the open chat's strip (the
// conversation's servers, running or not, in words) and the sidebar row's mark
// (only while one is up). The strip's own placement is
// conversationStripLocalServers.test.tsx.
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { StudioLocalServer } from '../../../../../packages/studio-protocol/src/public'
import { LocalServersRowMark, localServersRowMarkCopy, localServersStripCopy } from './LocalServerMarks'

function server(overrides: Partial<StudioLocalServer> = {}): StudioLocalServer {
  return {
    id: 'srv-1',
    agentId: 'agent-1',
    url: 'http://localhost:5173/',
    title: 'localhost:5173',
    port: 5173,
    state: 'running',
    linkedAt: 1,
    stateAt: 1,
    command: 'npm run dev',
    ...overrides,
  }
}

const storybook = (state: StudioLocalServer['state']) =>
  server({ id: 'srv-2', title: 'Storybook', url: 'http://localhost:6006/', port: 6006, state })
const docs = (state: StudioLocalServer['state']) =>
  server({ id: 'srv-3', title: 'Docs', url: 'http://localhost:4000/', port: 4000, state })

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(window as unknown as { api: unknown }).api = {}
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
})

async function render(node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(node))
  return host
}

test('the strip says nothing for a conversation that linked no server', () => {
  expect(localServersStripCopy([])).toBe(null)
})

test('one server is named with its state in a word', () => {
  expect(localServersStripCopy([server()])).toMatchObject({ label: 'localhost:5173', state: 'Running' })
  expect(localServersStripCopy([server({ state: 'starting' })])?.state).toBe('Starting')
  const stopped = localServersStripCopy([server({ state: 'stopped', lastExit: { code: 1, at: 2, output: '' } })])
  expect(stopped?.state).toBe('Stopped')
  expect(stopped?.ariaLabel).toContain('exited with code 1')
})

test('several servers are counted with how many are up', () => {
  const three = localServersStripCopy([server(), storybook('running'), docs('stopped')])
  expect(`${three?.label} · ${three?.state}`).toBe('3 servers · 2 running')
  expect(localServersStripCopy([server(), storybook('starting')])?.state).toBe('1 running, 1 starting')
  expect(localServersStripCopy([server({ state: 'stopped' }), storybook('stopped')])?.state).toBe('all stopped')
})

test('the sidebar mark counts what is up and says nothing when all have stopped', () => {
  expect(localServersRowMarkCopy([])).toBe(null)
  expect(localServersRowMarkCopy([server({ state: 'stopped' }), storybook('stopped')])).toBe(null)
  const copy = localServersRowMarkCopy([server(), storybook('starting'), docs('stopped')])
  expect(copy?.count).toBe(2)
  expect(copy?.title).toBe('Local servers: 1 running, 1 starting')
  expect(copy?.lines).toEqual(['localhost:5173 — Running', 'Storybook — Starting', 'Docs — Stopped'])
})

test('the sidebar mark is drawn only while a server is up, with the count', async () => {
  const stopped = await render(<LocalServersRowMark workspaceId="ws-1" servers={[server({ state: 'stopped' })]} />)
  expect(stopped.querySelector('[data-local-servers-mark]')).toBe(null)
  await act(async () => root!.unmount())

  const running = await render(<LocalServersRowMark workspaceId="ws-1" servers={[server(), storybook('stopped')]} />)
  const mark = running.querySelector('[data-local-servers-mark]')
  expect(mark?.textContent).toBe('1')
  expect(mark?.getAttribute('aria-label')).toContain('Local server: 1 running')
  expect(mark?.getAttribute('aria-haspopup')).toBe('menu')
})
