import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, test } from 'vitest'

import type { ScheduledAgentView } from '../../../shared/scheduled-agents'
import { resetScheduledAgentsStoreForTests, useScheduledAgents } from './scheduledAgentsStore'

afterEach(() => resetScheduledAgentsStoreForTests())

test('a broadcast that lands before the first fetch answers is not overwritten by that older answer', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window
  anyGlobal.document = dom.window.document
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

  const older = [{ id: 'sa-1' }] as ScheduledAgentView[]
  const newer = [{ id: 'sa-1' }, { id: 'sa-2' }] as ScheduledAgentView[]
  let answerList: (agents: ScheduledAgentView[]) => void = () => {}
  let broadcast: (agents: unknown) => void = () => {}
  ;(dom.window as unknown as { api: unknown }).api = {
    listScheduledAgents: () =>
      new Promise<ScheduledAgentView[]>((resolve) => {
        answerList = resolve
      }),
    onScheduledAgentsChanged: (listener: (agents: unknown) => void) => {
      broadcast = listener
      return () => {}
    },
  }

  let seen: ScheduledAgentView[] = []
  function Probe() {
    seen = useScheduledAgents()
    return null
  }
  const root = createRoot(dom.window.document.body)
  await act(async () => root.render(createElement(Probe)))

  // A schedule is made in another window; its broadcast beats the fetch.
  await act(async () => broadcast(newer))
  assert.deepEqual(
    seen.map((agent) => agent.id),
    ['sa-1', 'sa-2'],
  )
  // The fetch, asked before that change, answers with the list as it was.
  await act(async () => answerList(older))
  assert.deepEqual(
    seen.map((agent) => agent.id),
    ['sa-1', 'sa-2'],
    'the newer list stands',
  )
  await act(async () => root.unmount())
})
