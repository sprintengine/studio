import React from 'react'
import { JSDOM } from 'jsdom'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import {
  approvalOutsideWorkspace,
  ConversationPendingDock,
  ConversationPermissionCard,
  orderedPendingRequests,
} from './pendingDock'
import type { TranscriptEntry } from './conversationProjection'

type Approval = Extract<TranscriptEntry, { kind: 'approval' }>
const request = (requestId: string, extra: Partial<Approval> = {}): Approval => ({
  kind: 'approval',
  requestId,
  status: 'pending',
  action: 'Bash',
  summary: 'git status',
  input: { command: 'git status' },
  ...extra,
})

test('permission review shows the full command and proposed patch before approval', () => {
  const shell = renderToStaticMarkup(
    <ConversationPermissionCard
      entry={request('shell', {
        summary: 'Run a truncated command…',
        input: { command: 'git diff -- src/example.ts' },
      })}
      onApprove={() => undefined}
      busy={false}
    />,
  )
  expect(shell).toContain('git diff -- src/example.ts')
  const patch = renderToStaticMarkup(
    <ConversationPermissionCard
      entry={request('patch', {
        action: 'Edit',
        input: {
          edits: [
            { path: 'example.txt', patch: '--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-before\n+after\n' },
          ],
        },
      })}
      onApprove={() => undefined}
      busy={false}
    />,
  )
  expect(patch).toContain('Changes in example.txt')
  expect(patch).toContain('before')
  expect(patch).toContain('after')
})

test('pending requests keep FIFO within kind and show truthful origin/path warnings', () => {
  const entries = [
    request('plan', { requestKind: 'plan' }),
    request('q', { requestKind: 'question' }),
    request('first'),
    request('second'),
    request('settled', { status: 'approved' }),
  ]
  expect(orderedPendingRequests(entries).map((entry) => entry.requestId)).toEqual(['first', 'second', 'q', 'plan'])
  expect(
    approvalOutsideWorkspace(
      request('read', { action: 'Read', input: { file_path: '../private.txt' } }),
      '/Users/dev/project',
    ),
  ).toBe(true)
  expect(
    approvalOutsideWorkspace(
      request('read', { action: 'Read', input: { file_path: 'src/app.ts' } }),
      '/Users/dev/project',
    ),
  ).toBe(false)
  expect(
    approvalOutsideWorkspace(request('shell', { input: { command: 'cat /etc/hosts' } }), '/Users/dev/project'),
  ).toBe(true)
  expect(approvalOutsideWorkspace(request('cwd', { cwd: '/Users/dev/other' }), '/Users/dev/project')).toBe(true)
  const html = renderToStaticMarkup(
    <ConversationPermissionCard
      entry={request('r', { originAgentId: 'worker', input: { command: 'cat /etc/hosts' } })}
      workspaceRoot="/Users/dev/project"
      onApprove={() => undefined}
      busy={false}
    />,
  )
  expect(html).toContain('Requested by subagent')
  expect(html).toContain('outside this workspace')
  const blocked = renderToStaticMarkup(
    <ConversationPermissionCard
      entry={request('r', { suppressAlwaysAllowRule: true })}
      workspaceRoot="/Users/dev/project"
      onApprove={() => undefined}
      busy={false}
    />,
  )
  expect(blocked).not.toContain('Remember permission')
  expect(blocked).toContain('Allow once')
})

test('queue navigation preserves question answers, resolves selected ids, and defaults unsafe Enter to Deny', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('root')!)
  const onApprove = vi.fn()
  const entries = [
    request('first'),
    request('second', { defaultToNo: true }),
    request('question', {
      requestKind: 'question',
      questions: [
        {
          question: 'Choose a mode',
          header: 'Mode',
          options: [
            { label: 'Fast', description: '' },
            { label: 'Careful', description: '' },
          ],
          multiSelect: false,
        },
      ],
    }),
  ]
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (element) =>
        (element.getAttribute('aria-label') === label || element.textContent?.trim() === label) &&
        !element.closest('[hidden]'),
    )!
  const activeCard = () =>
    [...document.querySelectorAll<HTMLElement>('[role="group"]')].find((element) => !element.closest('[hidden]'))!
  const press = (element: Element, key: string, altKey = false) =>
    element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, altKey, bubbles: true, cancelable: true }))
  try {
    await act(async () =>
      root.render(
        <ConversationPendingDock
          pendingApprovals={entries}
          workspaceRoot="/Users/dev/project"
          onApprove={onApprove}
          busy={false}
        />,
      ),
    )
    expect(document.querySelector('[role="status"]')?.textContent).toBe('1/3')
    await act(async () => press(activeCard(), 'ArrowRight', true))
    expect(document.querySelector('[role="status"]')?.textContent).toBe('2/3')
    expect(document.activeElement).toBe(button('Deny'))
    await act(async () => press(activeCard(), 'Enter'))
    expect(onApprove).toHaveBeenLastCalledWith('second', false, undefined, 'deny')
    onApprove.mockClear()
    await act(async () => {
      press(button('Deny'), 'Enter')
      button('Deny').click()
    })
    expect(onApprove).toHaveBeenCalledExactlyOnceWith('second', false, undefined, 'deny')
    await act(async () => button('Next request').click())
    await act(async () => press(activeCard(), '1'))
    const selected = () => document.querySelector('[aria-label="Mode"] [aria-checked="true"]')
    // Selection survives leaving and returning to the question's mounted card.
    await act(async () => button('Previous request').click())
    await act(async () => button('Next request').click())
    expect(selected()?.textContent).toContain('Fast')
    const answerInput = document.querySelector<HTMLInputElement>('[aria-label="Other answer for: Choose a mode"]')!
    await act(async () =>
      answerInput.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', {
          key: 'Enter',
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    )
    expect(onApprove).toHaveBeenCalledTimes(1)
    await act(async () => press(activeCard(), 'Enter'))
    expect(onApprove).toHaveBeenLastCalledWith('question', true, { 'Choose a mode': 'Fast' })
    await act(async () =>
      root.render(
        <ConversationPendingDock
          pendingApprovals={[entries[0]]}
          workspaceRoot="/Users/dev/project"
          onApprove={onApprove}
          busy={false}
        />,
      ),
    )
    await act(async () => button('Allow once').click())
    expect(onApprove).toHaveBeenLastCalledWith('first', true, undefined, 'once')
    await act(async () => button('Remember permission').click())
    await act(async () => button('Always allow in this workspace').click())
    expect(onApprove).toHaveBeenLastCalledWith('first', true, undefined, 'always')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const key of [
      'window',
      'document',
      'navigator',
      'HTMLElement',
      'Element',
      'Node',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'IS_REACT_ACT_ENVIRONMENT',
    ]) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
