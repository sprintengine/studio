// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { GH_NEEDED_FOR } from '../../../../shared/host-gh'
import { MachineGhRow, WslGhSection } from './MachineGhRow'

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete (window as { api?: unknown }).api
})

function render(node: React.ReactNode): string {
  act(() => root.render(<ul>{node}</ul>))
  return host.textContent ?? ''
}

test('a missing gh says why it is needed and where to install it, on a Mac SSH machine by Homebrew', () => {
  const text = render(
    <MachineGhRow
      status={{ installed: false, version: null, signedIn: null }}
      machine={{ kind: 'ssh', os: 'Darwin' }}
      machineLabel="mac-mini"
    />,
  )
  expect(text).toContain('GitHub CLI')
  expect(text).toContain('Not installed — no gh on mac-mini.')
  expect(text).toContain('brew install gh')
  expect(text).toContain(GH_NEEDED_FOR)
})

test('on Linux the install hint is the GitHub CLI’s own instructions, never a guessed package manager', () => {
  const text = render(
    <MachineGhRow
      status={{ installed: false, version: null, signedIn: null }}
      machine={{ kind: 'wsl' }}
      machineLabel="WSL: Ubuntu"
    />,
  )
  expect(text).toContain('https://github.com/cli/cli#installation')
  expect(text).not.toMatch(/apt|dnf|pacman/u)
})

test('a WSL gh that is not signed in names both ways to sign in, and runs neither', () => {
  const text = render(
    <MachineGhRow
      status={{ installed: true, version: '2.62.0', signedIn: false }}
      machine={{ kind: 'wsl' }}
      machineLabel="WSL: Ubuntu"
    />,
  )
  expect(text).toContain('Installed, not signed in. Run gh auth login in a terminal on WSL: Ubuntu')
  expect(text).toContain('gh.exe auth token | gh auth login --with-token')
  expect(text).toContain('2.62.0')
})

test('an SSH gh that is not signed in names gh auth login only', () => {
  const text = render(
    <MachineGhRow
      status={{ installed: true, version: '2.62.0', signedIn: false }}
      machine={{ kind: 'ssh', os: 'Linux' }}
      machineLabel="build-box"
    />,
  )
  expect(text).toContain('Run gh auth login in a terminal on build-box.')
  expect(text).not.toContain('gh.exe')
})

test('a signed-in gh says so', () => {
  const text = render(
    <MachineGhRow
      status={{ installed: true, version: '2.62.0', signedIn: true }}
      machine={{ kind: 'ssh', os: 'Linux' }}
      machineLabel="build-box"
    />,
  )
  expect(text).toContain('Installed and signed in.')
})

test('the WSL section asks the machine, and asks again on a re-check', async () => {
  const asked: string[] = []
  ;(window as { api?: unknown }).api = {
    probeHostGh: async (hostId: string) => {
      asked.push(hostId)
      return { installed: true, version: '2.60.1', signedIn: true }
    },
  }
  await act(async () => root.render(<WslGhSection hostId="wsl:Ubuntu" label="WSL: Ubuntu" recheck={0} />))
  expect(host.textContent).toContain('Installed and signed in.')
  await act(async () => root.render(<WslGhSection hostId="wsl:Ubuntu" label="WSL: Ubuntu" recheck={1} />))
  expect(asked).toEqual(['wsl:Ubuntu', 'wsl:Ubuntu'])
})

test('a machine that does not answer is not called missing', async () => {
  ;(window as { api?: unknown }).api = { probeHostGh: async () => null }
  await act(async () => root.render(<WslGhSection hostId="wsl:Ubuntu" label="WSL: Ubuntu" recheck={0} />))
  expect(host.textContent).toContain('WSL: Ubuntu did not say whether gh is installed.')
  expect(host.textContent).not.toContain('Not installed')
})
