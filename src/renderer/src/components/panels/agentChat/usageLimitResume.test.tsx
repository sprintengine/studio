// @vitest-environment jsdom
//
// A chat a usage limit stopped: the tray row says which limit and when it
// resets, offers Resume at reset, Dismiss and the setting; with a resume
// scheduled it says when it goes out, and Cancel takes it back.
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type {
  UsageLimitResumeNotice,
  UsageLimitResumeState,
  UsageLimitResumeUpdate,
} from '../../../../../shared/usage-limit-resume'
import { useUsageLimitResumeStore } from '../../../store/usageLimitResumeStore'
import { formatResumeClock, UsageLimitResumeRow, usageLimitResumeWords } from './usageLimitResume'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
// 21:27 local today, so a reset two hours on is still today, and one a few days on is not.
const NOW = new Date(2026, 9, 7, 21, 27, 0).getTime()

function notice(overrides: Partial<UsageLimitResumeNotice> = {}): UsageLimitResumeNotice {
  return {
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    provider: 'claude',
    limit: 'session',
    resetsAt: NOW + 2 * HOUR + 13 * MINUTE + 30_000,
    hitAt: NOW - MINUTE,
    resumeAt: null,
    ...overrides,
  }
}

// The rows read the real clock, so what they draw is set against it.
const LIVE = Date.now()
const live = (overrides: Partial<UsageLimitResumeNotice> = {}) =>
  notice({ resetsAt: LIVE + 2 * HOUR, hitAt: LIVE - MINUTE, ...overrides })

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

let root: Root | null = null
let host: HTMLElement | null = null
let updates: UsageLimitResumeUpdate[] = []

function installApi(state: UsageLimitResumeState) {
  updates = []
  ;(window as unknown as { api: unknown }).api = {
    usageLimitResumes: async () => state,
    updateUsageLimitResume: async (update: UsageLimitResumeUpdate) => {
      updates.push(update)
      return state
    },
    onUsageLimitResumesChanged: () => () => undefined,
  }
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
  useUsageLimitResumeStore.setState({ state: null })
})

async function render(node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(node))
  return host
}

const buttons = (element: HTMLElement) => [...element.querySelectorAll('button')].map((button) => button.textContent)

async function click(element: HTMLElement, label: string) {
  const button = [...element.querySelectorAll('button')].find((candidate) => candidate.textContent === label)!
  await act(async () => button.click())
}

test('the notice names the limit and says when it resets, or when the chat resumes', () => {
  expect(usageLimitResumeWords(notice(), NOW)).toBe(
    `Claude's session limit is used up. It resets at ${clock(notice().resetsAt!)} (in 2h 13m).`,
  )
  const resumeAt = NOW + 2 * HOUR + 15 * MINUTE
  expect(usageLimitResumeWords(notice({ resumeAt, provider: 'codex', limit: 'weekly' }), NOW)).toBe(
    `Codex's weekly limit is used up. Resumes at ${clock(resumeAt)} (in 2h 15m).`,
  )
  expect(usageLimitResumeWords(notice({ limit: null, resetsAt: null }), NOW)).toBe(
    "Claude's usage limit is used up. It did not say when it resets.",
  )
})

test('a reset on another day names the day', () => {
  expect(formatResumeClock(NOW + HOUR, NOW)).toBe(clock(NOW + HOUR))
  expect(formatResumeClock(NOW + 3 * 24 * HOUR, NOW)).toMatch(new RegExp(`^\\S+ ${clock(NOW + 3 * 24 * HOUR)}$`))
  expect(formatResumeClock(NOW + 9 * 24 * HOUR, NOW)).toMatch(new RegExp(`, ${clock(NOW + 9 * 24 * HOUR)}$`))
})

test('a chat a limit stopped offers Resume at reset, Dismiss and the setting, and each asks main', async () => {
  const state: UsageLimitResumeState = { autoResume: false, notices: [live()] }
  installApi(state)
  const row = await render(<UsageLimitResumeRow workspaceId="ws-1" agentId="agent-1" />)
  expect(row.textContent).toMatch(/^Claude's session limit is used up\. It resets at /)
  expect(buttons(row)).toEqual(['Always resume at reset', 'Resume at reset', 'Dismiss'])
  await click(row, 'Resume at reset')
  await click(row, 'Dismiss')
  await click(row, 'Always resume at reset')
  expect(updates).toEqual([
    { kind: 'schedule', workspaceId: 'ws-1', agentId: 'agent-1' },
    { kind: 'dismiss', workspaceId: 'ws-1', agentId: 'agent-1' },
    { kind: 'auto', enabled: true },
    { kind: 'schedule', workspaceId: 'ws-1', agentId: 'agent-1' },
  ])
})

test('with the setting on the link is not offered; with no reset known nothing can be scheduled', async () => {
  installApi({ autoResume: true, notices: [live({ resetsAt: null })] })
  const row = await render(<UsageLimitResumeRow workspaceId="ws-1" agentId="agent-1" />)
  expect(buttons(row)).toEqual(['Dismiss'])
})

test('a scheduled resume says when it goes out, and Cancel takes it back', async () => {
  installApi({ autoResume: true, notices: [live({ resumeAt: LIVE + 2 * HOUR + 2 * MINUTE })] })
  const row = await render(<UsageLimitResumeRow workspaceId="ws-1" agentId="agent-1" />)
  expect(row.textContent).toMatch(/ Resumes at /)
  expect(buttons(row)).toEqual(['Cancel'])
  await click(row, 'Cancel')
  expect(updates).toEqual([{ kind: 'cancel', workspaceId: 'ws-1', agentId: 'agent-1' }])
})

test("another chat's notice, or one whose limit has reset with nothing scheduled, draws nothing", async () => {
  installApi({
    autoResume: false,
    notices: [live({ agentId: 'agent-2' }), live({ workspaceId: 'ws-3', resetsAt: LIVE - MINUTE })],
  })
  const row = await render(
    <>
      <UsageLimitResumeRow workspaceId="ws-1" agentId="agent-1" />
      <UsageLimitResumeRow workspaceId="ws-3" agentId="agent-1" />
    </>,
  )
  expect(row.textContent).toBe('')
})

test('a resume the chat refused says why, with Retry, even after the limit has reset', async () => {
  installApi({
    autoResume: true,
    notices: [live({ resetsAt: LIVE - MINUTE, failure: 'The chat has no folder on this machine' })],
  })
  const row = await render(<UsageLimitResumeRow workspaceId="ws-1" agentId="agent-1" />)
  expect(row.textContent).toMatch(/^Couldn't resume: the chat has no folder on this machine\./)
  expect(buttons(row)).toEqual(['Retry', 'Dismiss'])
  await click(row, 'Retry')
  expect(updates).toEqual([{ kind: 'retry', workspaceId: 'ws-1', agentId: 'agent-1' }])
})
