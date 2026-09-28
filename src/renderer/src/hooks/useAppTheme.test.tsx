// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test } from 'vitest'

import { useWorkspaceStore } from '../store/workspaceStore'
import { applyChatAppearance, useAppTheme } from './useAppTheme'

const html = document.documentElement

afterEach(() => {
  applyChatAppearance(html, 100, 'full')
})

test('the default chat appearance leaves the theme inks alone', () => {
  applyChatAppearance(html, 100, 'full')
  expect(html.getAttribute('data-chat-width')).toBe('full')
  expect(html.hasAttribute('data-chat-contrast')).toBe(false)
  expect(html.style.getPropertyValue('--chat-contrast-keep')).toBe('')
})

test('lower contrast keeps a share of each ink and adds no boost', () => {
  applyChatAppearance(html, 90, 'comfortable')
  expect(html.getAttribute('data-chat-width')).toBe('comfortable')
  expect(html.getAttribute('data-chat-contrast')).toBe('lower')
  expect(html.style.getPropertyValue('--chat-contrast-keep')).toBe('90%')
  expect(html.style.getPropertyValue('--chat-contrast-boost')).toBe('0%')
})

test('higher contrast boosts by half the distance past the default', () => {
  applyChatAppearance(html, 160, 'wide')
  expect(html.getAttribute('data-chat-contrast')).toBe('higher')
  expect(html.style.getPropertyValue('--chat-contrast-keep')).toBe('100%')
  expect(html.style.getPropertyValue('--chat-contrast-boost')).toBe('30%')
  applyChatAppearance(html, 100, 'wide')
  expect(html.hasAttribute('data-chat-contrast')).toBe(false)
  expect(html.style.getPropertyValue('--chat-contrast-boost')).toBe('')
})

test('the mounted hook follows the store as the settings change', async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  function Themed() {
    useAppTheme()
    return null
  }
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(<Themed />))
  await act(async () => {
    useWorkspaceStore.getState().setAppearanceChatWidth('wide')
    useWorkspaceStore.getState().setAppearanceChatContrast(150)
  })
  expect(html.getAttribute('data-chat-width')).toBe('wide')
  expect(html.style.getPropertyValue('--chat-contrast-boost')).toBe('25%')
  await act(async () => {
    useWorkspaceStore.getState().setAppearanceChatWidth('full')
    useWorkspaceStore.getState().setAppearanceChatContrast(100)
  })
  expect(html.getAttribute('data-chat-width')).toBe('full')
  expect(html.hasAttribute('data-chat-contrast')).toBe(false)
  await act(async () => root.unmount())
})

test('the boot script stamps the persisted chat appearance before the first paint, as the hook would', () => {
  const page = readFileSync(join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8')
  const boot = /<script>([\s\S]*?)<\/script>/.exec(page)![1]!
  const stamped = (appearance: Record<string, unknown>) => {
    applyChatAppearance(html, 100, 'full')
    html.removeAttribute('data-chat-width')
    window.localStorage.setItem('sprintengine-app-settings', JSON.stringify({ state: { appSettings: { appearance } } }))
    new Function(boot)()
    return {
      width: html.getAttribute('data-chat-width'),
      contrast: html.getAttribute('data-chat-contrast'),
      keep: html.style.getPropertyValue('--chat-contrast-keep'),
      boost: html.style.getPropertyValue('--chat-contrast-boost'),
    }
  }
  const expected = (contrast: number, width: 'full' | 'wide' | 'comfortable') => {
    applyChatAppearance(html, contrast, width)
    return {
      width: html.getAttribute('data-chat-width'),
      contrast: html.getAttribute('data-chat-contrast'),
      keep: html.style.getPropertyValue('--chat-contrast-keep'),
      boost: html.style.getPropertyValue('--chat-contrast-boost'),
    }
  }
  try {
    expect(stamped({ chatWidth: 'comfortable', chatContrast: 160 })).toEqual(expected(160, 'comfortable'))
    expect(stamped({ chatWidth: 'wide', chatContrast: 87 })).toEqual(expected(85, 'wide'))
    expect(stamped({ chatContrast: 100 })).toEqual(expected(100, 'full'))
    expect(stamped({ chatWidth: 'enormous', chatContrast: 'loud' })).toEqual(expected(100, 'full'))
  } finally {
    window.localStorage.removeItem('sprintengine-app-settings')
  }
})
