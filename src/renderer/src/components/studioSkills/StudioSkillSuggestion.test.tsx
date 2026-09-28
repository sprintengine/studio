import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, test } from 'vitest'

import type { StudioAreaSkillChoices, StudioAreaSkillId } from '../../../../shared/studio-area-skills'
import { resetStudioAreaSkillsStoreForTests } from '../../store/studioAreaSkillsStore'
import { StudioSkillsSettings } from '../settings/StudioSkillsSettings'
import { StudioSkillSuggestion } from './StudioSkillSuggestion'

// A surface offering its Studio skill, and the Settings switches for all six:
// both read the one record main keeps, so an answer in either place shows in
// the other. Main here is an in-memory stand-in with the same rules.

let root: Root
let container: HTMLElement
let record: StudioAreaSkillChoices

function installMain(initial: StudioAreaSkillChoices) {
  record = initial
  const listeners = new Set<(choices: StudioAreaSkillChoices) => void>()
  const commit = (next: StudioAreaSkillChoices) => {
    record = next
    for (const listener of listeners) listener(record)
    return record
  }
  ;(window as unknown as { api: unknown }).api = {
    studioAreaSkillsGet: async () => record,
    studioAreaSkillsSetEnabled: async ({ skillId, enabled }: { skillId: StudioAreaSkillId; enabled: boolean }) =>
      commit({
        enabled: enabled ? [...record.enabled, skillId] : record.enabled.filter((id) => id !== skillId),
        dismissed: enabled ? record.dismissed : [...record.dismissed, skillId],
      }),
    studioAreaSkillsDismiss: async ({ skillId }: { skillId: StudioAreaSkillId }) =>
      commit({ enabled: record.enabled, dismissed: [...record.dismissed, skillId] }),
    onStudioAreaSkillsChanged: (cb: (choices: StudioAreaSkillChoices) => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}

async function mount(node: React.ReactNode) {
  await act(async () => {
    root.render(node)
  })
  // The first read resolves after mount.
  await act(async () => {
    await Promise.resolve()
  })
}

const offer = () => container.querySelector('[role="group"][aria-label="Backlog skill for agents"]')
const button = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent === label)
const backlogSwitch = () => {
  const label = [...container.querySelectorAll('div')].find((el) => el.textContent === 'Backlog' && el.id)
  return container.querySelector<HTMLElement>(`[aria-labelledby="${label?.id}"]`)
}

beforeEach(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.window.document
  g.navigator = dom.window.navigator
  g.HTMLElement = dom.window.HTMLElement
  g.HTMLButtonElement = dom.window.HTMLButtonElement
  g.Node = dom.window.Node
  g.MouseEvent = dom.window.MouseEvent
  g.KeyboardEvent = dom.window.KeyboardEvent
  g.getComputedStyle = dom.window.getComputedStyle
  g.IS_REACT_ACT_ENVIRONMENT = true
  container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  root = createRoot(container)
  resetStudioAreaSkillsStoreForTests()
})

afterEach(async () => {
  await act(async () => root.unmount())
})

test('a surface offers its skill until the person answers, and Install switches it on in Settings', async () => {
  installMain({ enabled: [], dismissed: [] })
  await mount(
    <>
      <StudioSkillSuggestion skillId="studio-backlog" />
      <StudioSkillsSettings />
    </>,
  )
  assert.ok(offer(), 'nothing chosen yet: the Backlog surface offers its skill')
  assert.equal(backlogSwitch()?.getAttribute('aria-checked'), 'false')

  await act(async () => {
    button('Install')!.click()
  })
  assert.deepEqual(record.enabled, ['studio-backlog'])
  assert.equal(offer(), null, 'answered: the offer is gone')
  assert.equal(backlogSwitch()?.getAttribute('aria-checked'), 'true', 'and the Settings switch shows it on')
})

test('Not now is remembered, and a skill switched off in Settings is not offered back', async () => {
  installMain({ enabled: [], dismissed: [] })
  await mount(<StudioSkillSuggestion skillId="studio-backlog" />)
  await act(async () => {
    button('Not now')!.click()
  })
  assert.deepEqual(record.dismissed, ['studio-backlog'])
  assert.equal(offer(), null)

  // A fresh window reading a record where the person installed it, then
  // switched it off: that is an answer, so no offer.
  await act(async () => root.unmount())
  root = createRoot(container)
  resetStudioAreaSkillsStoreForTests()
  installMain({ enabled: ['studio-backlog'], dismissed: [] })
  await mount(
    <>
      <StudioSkillSuggestion skillId="studio-backlog" />
      <StudioSkillsSettings />
    </>,
  )
  assert.equal(offer(), null, 'installed: nothing to offer')
  await act(async () => {
    backlogSwitch()!.click()
  })
  assert.deepEqual(record.enabled, [])
  assert.equal(offer(), null, 'switched off in Settings: still not offered')
})

test('nothing is offered before main has said what was already chosen', async () => {
  installMain({ enabled: ['studio-backlog'], dismissed: [] })
  ;(window as unknown as { api: { studioAreaSkillsGet: () => Promise<never> } }).api.studioAreaSkillsGet = () =>
    new Promise<never>(() => undefined)
  await mount(<StudioSkillSuggestion skillId="studio-backlog" />)
  assert.equal(offer(), null)
})
