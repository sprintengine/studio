// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { SshPromptRequest } from '../../../../shared/ssh-environments'
import { SshPromptDialogHost } from './SshPromptDialog'

let root: Root
let host: HTMLDivElement
let emit: (request: SshPromptRequest) => void = () => undefined
let close: (id: string) => void = () => undefined
const answers: Array<[string, string | null]> = []
const api = {
  onSshPrompt: (cb: (request: SshPromptRequest) => void) => ((emit = cb), () => undefined),
  onSshPromptClosed: (cb: (id: string) => void) => ((close = cb), () => undefined),
  sshPromptAnswer: (id: string, answer: string | null) => void answers.push([id, answer]),
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  answers.length = 0
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<SshPromptDialogHost api={api} />))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const later = Date.now() + 60_000
const button = (name: string) =>
  [...document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === name,
  ) as HTMLButtonElement

test('a new host key shows its fingerprint, and Trust is never the focused default', () => {
  act(() =>
    emit({
      id: 'p1',
      label: 'build-box',
      kind: 'host-key',
      text: '',
      hostKey: { host: '[127.0.0.1]:2222', keyType: 'ED25519', fingerprint: 'SHA256:abc' },
      expiresAt: later,
    }),
  )
  expect(document.body.textContent).toContain('New machine: build-box')
  expect(document.querySelector('[data-testid="ssh-fingerprint"]')?.textContent).toBe('SHA256:abc')
  expect(document.activeElement).not.toBe(button('Trust and connect'))
  act(() => button('Trust and connect').click())
  expect(answers).toEqual([['p1', 'yes']])
})

test("a remote's question is shown verbatim inside a frame that names the machine; cancel answers nothing", () => {
  act(() =>
    emit({
      id: 'p2',
      label: 'build-box',
      kind: 'remote',
      text: "(dev@build-box) Enter passphrase for key '/Users/dev/.ssh/id_ed25519':",
      expiresAt: later,
    }),
  )
  expect(document.body.textContent).toContain('build-box asks:')
  expect(document.querySelector('[data-testid="ssh-remote-text"]')?.textContent).toContain(
    '(dev@build-box) Enter passphrase',
  )
  expect(document.body.textContent).not.toContain('The passphrase for your SSH key')
  act(() => button('Cancel').click())
  expect(answers).toEqual([['p2', null]])
})

test('a password is typed and sent once; a prompt main closed goes away', () => {
  act(() =>
    emit({ id: 'p3', label: 'build-box', kind: 'password', text: "dev@build-box's password:", expiresAt: later }),
  )
  const input = document.querySelector('input[type="password"]') as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, 'hunter2')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => button('Continue').click())
  expect(answers).toEqual([['p3', 'hunter2']])
  act(() => emit({ id: 'p4', label: 'build-box', kind: 'touch', text: 'Confirm user presence', expiresAt: later }))
  expect(document.body.textContent).toContain('Touch your security key')
  act(() => close('p4'))
  expect(document.body.textContent).not.toContain('Touch your security key')
})

test("a sign-in shows the machine's link and code; a paste-back sends the code; a device code closes on its own", () => {
  act(() =>
    emit({
      id: 's1',
      label: 'build-box',
      kind: 'sign-in',
      text: 'Sign in to codex on build-box.',
      signIn: { cli: 'codex', url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGHI', paste: false },
      expiresAt: later,
    }),
  )
  expect(document.querySelector('[data-testid="ssh-sign-in-url"]')?.textContent).toBe(
    'https://auth.openai.com/codex/device',
  )
  expect(document.querySelector('[data-testid="ssh-sign-in-code"]')?.textContent).toBe('ABCD-EFGHI')
  expect(button('Continue')).toBeUndefined()
  act(() => close('s1'))
  act(() =>
    emit({
      id: 's2',
      label: 'build-box',
      kind: 'sign-in',
      text: 'Sign in to claude on build-box.',
      signIn: { cli: 'claude-code', url: 'https://claude.com/cai/oauth/authorize', code: null, paste: true },
      expiresAt: later,
    }),
  )
  const input = document.querySelector('input') as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, 'pasted-code')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => button('Continue').click())
  expect(answers).toContainEqual(['s2', 'pasted-code'])
})

test('a passphrase question an older ssh cannot vouch for is shown verbatim, framed, and says so', () => {
  act(() =>
    emit({
      id: 'u1',
      label: 'build-box',
      kind: 'passphrase',
      text: "Enter passphrase for key '/Users/dev/.ssh/id_ed25519':",
      unverified: true,
      expiresAt: later,
    }),
  )
  expect(document.body.textContent).not.toContain('The passphrase for your SSH key')
  expect(document.body.textContent).toContain('ssh or build-box asks:')
  expect(document.querySelector('[data-testid="ssh-unverified-text"]')?.textContent).toContain('Enter passphrase')
  expect(document.body.textContent).toContain('older than 8.4')
})

test('a login waiting for a pasted code is not sent an empty one', () => {
  act(() =>
    emit({
      id: 's3',
      label: 'build-box',
      kind: 'sign-in',
      text: 'Sign in to claude on build-box.',
      signIn: { cli: 'claude-code', url: 'https://claude.com/cai/oauth/authorize', code: null, paste: true },
      expiresAt: later,
    }),
  )
  expect(button('Continue').disabled).toBe(true)
  act(() => (document.querySelector('form') as HTMLFormElement).requestSubmit())
  expect(answers).toEqual([])
})
