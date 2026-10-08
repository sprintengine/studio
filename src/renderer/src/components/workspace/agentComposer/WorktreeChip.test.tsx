// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test } from 'vitest'

import { WorktreeChip } from './WorktreeChip'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.replaceChildren()
})

async function chip(name: string | null): Promise<HTMLButtonElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root!.render(<WorktreeChip name={name} onChange={() => {}} />))
  return host.querySelector<HTMLButtonElement>('[data-worktree-chip] button')!
}

test('the switch keeps one name in both states, and aria-pressed says which', async () => {
  const on = await chip('')
  expect(on.getAttribute('aria-label')).toBe('Run in a worktree')
  expect(on.getAttribute('aria-pressed')).toBe('true')
  await act(async () => root?.unmount())
  const off = await chip(null)
  expect(off.getAttribute('aria-label')).toBe('Run in a worktree')
  expect(off.getAttribute('aria-pressed')).toBe('false')
})

test('on and off are drawn apart: the thrown fill on, the mark stepped down off', async () => {
  const on = await chip('fix-login')
  expect(on.className).toContain('bg-[color:var(--bg-selected)]')
  expect(on.querySelector('svg')?.getAttribute('class')).not.toContain('--text-disabled')
  await act(async () => root?.unmount())
  const off = await chip(null)
  expect(off.className).not.toContain('bg-[color:var(--bg-selected)]')
  expect(off.querySelector('svg')?.getAttribute('class')).toContain('text-[color:var(--text-disabled)]')
})
