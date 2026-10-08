// @vitest-environment jsdom
//
// Settings pages with nothing to show say so with the kit's empty state, and
// pages still fetching with the kit's loading state — not a bare line of copy
// in a dialect of their own.
import type React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'

import { ConfirmDialogProvider } from '../ui/ConfirmDialog'
import { DesignSystemSettings } from './DesignSystemSettings'
import { ProjectKnowledgeList } from './ProjectKnowledgeList'
import { ProviderSettingsTab } from './ProviderSettingsTab'

function render(element: React.ReactElement, api: Record<string, unknown> = {}): HTMLElement {
  ;(window as unknown as { api: unknown }).api = api
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<ConfirmDialogProvider>{element}</ConfirmDialogProvider>)
  return host
}

// The kit's EmptyState: a centred column holding the title.
function emptyStateTitled(host: HTMLElement, title: string): Element | null {
  const column = host.querySelector('div.flex-col.items-center.text-center')
  return column?.querySelector('p')?.textContent === title ? column : null
}

test('Design system with no workspace open is the kit empty state', () => {
  expect(emptyStateTitled(render(<DesignSystemSettings workspaceRoot={null} />), 'Open a workspace first.')).not.toBe(
    null,
  )
})

test('Knowledge graph with no workspace open is the kit empty state', () => {
  expect(
    emptyStateTitled(render(<ProjectKnowledgeList activeProjectRoot={null} />), 'Open a workspace first.'),
  ).not.toBe(null)
})

test('Providers still loading is the kit loading state, announced', () => {
  const pending = new Promise(() => {})
  const status = render(<ProviderSettingsTab />, { conversationProvidersList: () => pending }).querySelector(
    '[role="status"]',
  )
  expect(status?.textContent).toBe('Loading providers…')
})
