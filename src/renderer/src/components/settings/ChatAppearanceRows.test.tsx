// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { useWorkspaceStore } from '../../store/workspaceStore'
import { SettingCard } from '../ui'
import { ChatAppearanceRows } from './ChatAppearanceRows'

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  useWorkspaceStore.getState().setAppearanceChatContrast(100)
  useWorkspaceStore.getState().setAppearanceChatWidth('full')
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root.render(
      <SettingCard>
        <ChatAppearanceRows />
      </SettingCard>,
    ),
  )
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const slider = () => host.querySelector<HTMLElement>('[role="slider"]')!
const press = (key: string) =>
  act(() => {
    slider().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
const contrast = () => useWorkspaceStore.getState().appSettings.appearance.chatContrast

test('the contrast slider is named by its row and announces the percentage', () => {
  const label = document.getElementById(slider().getAttribute('aria-labelledby')!)
  expect(label?.textContent).toBe('Chat text contrast')
  expect(slider().getAttribute('aria-valuetext')).toBe('100%')
  expect(host.querySelector('output')?.textContent).toBe('100%')
})

test('moving the slider stores the contrast a step at a time', () => {
  press('ArrowRight')
  expect(contrast()).toBe(105)
  press('ArrowLeft')
  press('ArrowLeft')
  expect(contrast()).toBe(95)
  press('End')
  expect(contrast()).toBe(200)
  expect(host.querySelector('output')?.textContent).toBe('200%')
})

test('reset appears off the default and returns to it', () => {
  expect(host.querySelector('[aria-label^="Reset chat text contrast"]')).toBeNull()
  press('ArrowRight')
  const reset = host.querySelector<HTMLButtonElement>('[aria-label="Reset chat text contrast to 100%"]')!
  act(() => reset.click())
  expect(contrast()).toBe(100)
  expect(host.querySelector('[aria-label^="Reset chat text contrast"]')).toBeNull()
})

test('the width control stores the chosen column', () => {
  const group = host.querySelector('[aria-label="Chat width"]')!
  const comfortable = [...group.querySelectorAll('button')].find((button) => button.textContent === 'Comfortable')!
  act(() => comfortable.click())
  expect(useWorkspaceStore.getState().appSettings.appearance.chatWidth).toBe('comfortable')
})
