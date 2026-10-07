// @vitest-environment jsdom
//
// The subscription's usage limits: a small bar on a Claude or Codex chat's
// composer strip, beside the context ring, and the list it opens — every
// provider's windows in words, with a bar each, the warn tone at 90% or at the
// limit, "reset" for a window whose reset has passed, and "as of" for a
// reading old enough to say so.
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { UsageLimitSnapshot, UsageLimitsState } from '../../../../../shared/usage-limits'
import { useUsageLimitsStore } from '../../../store/usageLimitsStore'
import { ConversationComposerStrip } from './conversationStrip'
import { headlineWindow, UsageLimitsPanel, usageReadingAge, usageStripLabel, usageWindowWords } from './usageLimits'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const NOW = Date.now()

function claude(overrides: Partial<UsageLimitSnapshot> = {}): UsageLimitSnapshot {
  return {
    provider: 'claude',
    billing: 'subscription',
    plan: 'max',
    observedAt: NOW,
    windows: [
      {
        id: 'five_hour',
        label: 'Session (5h)',
        usedPercent: 42,
        resetsAt: NOW + 2 * HOUR + 13 * MINUTE + 30_000,
        durationMs: 5 * HOUR,
        status: 'allowed',
        observedAt: NOW,
      },
      {
        id: 'seven_day',
        label: 'Weekly',
        usedPercent: 93,
        resetsAt: NOW + 3 * 24 * HOUR + 4 * HOUR + 30_000,
        durationMs: 7 * 24 * HOUR,
        status: 'warning',
        observedAt: NOW,
      },
    ],
    ...overrides,
  }
}

const codex: UsageLimitSnapshot = {
  provider: 'codex',
  billing: 'subscription',
  observedAt: NOW - 2 * HOUR,
  windows: [
    {
      id: 'codex:primary',
      label: 'Session (5h)',
      usedPercent: 100,
      resetsAt: NOW - MINUTE,
      durationMs: 5 * HOUR,
      status: 'rejected',
      observedAt: NOW - 2 * HOUR,
    },
  ],
}

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
  useUsageLimitsStore.setState({ state: null })
})

async function render(node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(node))
  return host
}

test('a window reads its share and its reset, and one whose reset passed reads "Reset"', () => {
  const [session, weekly] = claude().windows
  expect(usageWindowWords(session, NOW)).toBe('42% used · resets in 2h 13m')
  expect(usageWindowWords(weekly, NOW)).toBe('93% used · resets in 3d 4h')
  expect(usageWindowWords(codex.windows[0], NOW)).toBe('Reset')
  expect(usageWindowWords({ ...session, status: 'rejected' }, NOW)).toBe('Limit reached · resets in 2h 13m')
  // A status with no share says the status.
  expect(usageWindowWords({ ...session, usedPercent: null, status: 'warning' }, NOW)).toMatch(/^Close to the limit · /)
  expect(usageWindowWords({ ...session, usedPercent: null, resetsAt: null }, NOW)).toBe('Within the limit')
})

test('the strip names the fullest window that has not reset', () => {
  expect(headlineWindow(claude(), NOW)?.id).toBe('seven_day')
  expect(usageStripLabel(claude(), NOW)).toBe('Claude usage limits: Weekly, 93% used · resets in 3d 4h')
  expect(headlineWindow(codex, NOW)).toBe(null)
  expect(usageStripLabel(codex, NOW)).toBe('Codex usage limits: all windows reset')
})

test('a reading is dated only once it is old enough to be doubted', () => {
  expect(usageReadingAge(NOW - MINUTE, NOW)).toBe(null)
  expect(usageReadingAge(NOW - 2 * HOUR, NOW)).toMatch(/^as of /)
})

test("the list draws every provider, the chat's first, each window with a bar and its words", async () => {
  const state: UsageLimitsState = { snapshots: [claude(), codex] }
  const panel = await render(<UsageLimitsPanel state={state} first="codex" />)
  const sections = [...panel.querySelectorAll('[data-usage-provider]')]
  expect(sections.map((section) => section.getAttribute('data-usage-provider'))).toEqual(['codex', 'claude'])
  expect(sections[1].querySelector('h3')?.textContent).toBe('Claude · Max')
  // The stale Codex reading says when it was read.
  expect(sections[0].textContent).toMatch(/as of /)

  const meters = [...panel.querySelectorAll('[role="meter"]')]
  expect(meters.map((meter) => meter.getAttribute('aria-valuenow'))).toEqual([null, '42', '93'])
  // A reset window has no share to draw, and says so.
  expect(meters[0].getAttribute('aria-valuetext')).toBe('Reset')
  expect(meters[0].getAttribute('data-meter')).toBe('unknown')
  // 93% is a warning, and the pace marker stands at the time gone by.
  expect(meters[2].getAttribute('data-meter')).toBe('warn')
  expect(meters[1].getAttribute('data-meter')).toBe('default')
  expect(meters[1].getAttribute('aria-valuetext')).toMatch(/^42% used · resets in 2h 13m, (on|under|ahead of) pace$/)
  // Each bar is named by its window's label.
  const labelledBy = meters[1].getAttribute('aria-labelledby')!
  expect(panel.ownerDocument.getElementById(labelledBy)?.textContent).toBe('Session (5h)')
})

test('with nothing reported the list says so rather than guess', async () => {
  const panel = await render(<UsageLimitsPanel state={{ snapshots: [] }} />)
  expect(panel.querySelector('[data-usage-empty]')?.textContent).toMatch(/No usage limits reported yet/)
})

test('the strip draws the bar at its pinned end, before the ring, named in words', async () => {
  const strip = await render(
    <ConversationComposerStrip
      machine={null}
      branch={null}
      changes={null}
      context={{ used: 20_000, total: 200_000 }}
      usageLimits={claude()}
    />,
  )
  const slot = strip.querySelector('[data-strip-usage-limits-slot]')!
  expect(slot.className).toContain('ml-auto')
  expect(slot.nextElementSibling?.hasAttribute('data-strip-context')).toBe(true)
  const trigger = strip.querySelector<HTMLButtonElement>('[data-strip-usage-limits="claude"]')!
  expect(trigger.getAttribute('aria-label')).toBe('Claude usage limits: Weekly, 93% used · resets in 3d 4h')
  expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
  // The compact bar is the button's picture; the button carries the name.
  expect(trigger.querySelector('[data-meter]')?.getAttribute('aria-hidden')).toBe('true')
  expect(trigger.querySelector('[data-meter]')?.getAttribute('data-meter')).toBe('warn')
})

test('with no reading the strip draws no bar', async () => {
  const strip = await render(
    <ConversationComposerStrip
      machine={null}
      branch={null}
      changes={null}
      context={{ used: 20_000, total: 200_000 }}
      usageLimits={null}
    />,
  )
  expect(strip.querySelector('[data-strip-usage-limits-slot]')).toBe(null)
})
