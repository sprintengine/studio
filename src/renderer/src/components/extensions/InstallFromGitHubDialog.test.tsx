// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type {
  GithubExtensionInstallInput,
  GithubExtensionPreview,
  GithubExtensionResolveResult,
  MarketplacePluginRegistryInstallResult,
} from '../../../../shared/electron-api'
import {
  InstallFromGitHubDialog,
  installedStateLine,
  type InstallFromGitHubDialogProps,
} from './InstallFromGitHubDialog'

// The install resolves renderer-only modules after main answers; here main's
// answer is the whole story.
vi.mock('../../modules', () => ({
  installAndActivateRendererModules: (install: () => Promise<MarketplacePluginRegistryInstallResult>) => install(),
}))

const SHA = 'a1b2c3d'.padEnd(40, '0')

function preview(overrides: Partial<GithubExtensionPreview> = {}): GithubExtensionPreview {
  return {
    id: 'notes-ext',
    displayName: 'Notes',
    version: 2,
    publisher: { name: 'Acme', verified: false },
    summary: 'Notes, an extension for SprintEngine Studio.',
    provides: ['module'],
    origin: { url: 'https://github.com/acme/notes-ext', owner: 'acme', repo: 'notes-ext' },
    verify: {
      classification: 'unsigned',
      permissions: ['storage'],
      sourceUrl: `https://github.com/acme/notes-ext/tree/${SHA}`,
      codeBearing: true,
      pin: { commitSha: SHA, manifestSha256: 'f'.repeat(64), componentDigests: {} },
    },
    ...overrides,
  }
}

const resolveCalls: string[] = []
const installCalls: GithubExtensionInstallInput[] = []
let resolveAnswer: GithubExtensionResolveResult
let installAnswer: MarketplacePluginRegistryInstallResult

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  resolveCalls.length = 0
  installCalls.length = 0
  resolveAnswer = { ok: true, preview: preview(), trustToken: 'token-1' }
  installAnswer = {
    ok: true,
    id: 'notes-ext',
    displayName: 'Notes',
    version: 2,
    trust: 'trusted',
    loadEligible: true,
    installed: [],
    classification: 'unsigned',
    sourceUrl: `https://github.com/acme/notes-ext/tree/${SHA}`,
    updated: false,
  }
  ;(window as unknown as { api: unknown }).api = {
    resolveGithubExtension: async (input: { url: string }) => {
      resolveCalls.push(input.url)
      return resolveAnswer
    },
    installGithubExtension: async (input: GithubExtensionInstallInput) => {
      installCalls.push(input)
      return installAnswer
    },
  }
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
})

async function mount(props: Partial<InstallFromGitHubDialogProps> = {}): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  const created = createRoot(host)
  root = created
  await act(async () => created.render(<InstallFromGitHubDialog open onClose={() => {}} {...props} />))
}

const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement
const button = (label: string) =>
  [...dialog().querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label) as
    HTMLButtonElement | undefined

async function typeUrl(value: string): Promise<void> {
  const input = dialog().querySelector('input[aria-label="Repository URL"]') as HTMLInputElement
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function click(target: HTMLElement | undefined): Promise<void> {
  expect(target).toBeTruthy()
  await act(async () => {
    target!.click()
  })
}

test('a pasted repository is reviewed by main, and unsigned code waits for "I trust this code"', async () => {
  await mount({ workspaceRoot: '/Users/dev/project' })
  await typeUrl('https://github.com/acme/notes-ext')
  await click(button('Review'))
  expect(resolveCalls).toEqual(['https://github.com/acme/notes-ext'])

  const text = dialog().textContent ?? ''
  expect(text).toContain('Notes')
  expect(text).toContain('Unsigned code')
  expect(text).toContain(SHA)
  expect(text).toContain('https://github.com/acme/notes-ext')

  const install = button('Trust and install')
  expect(install?.disabled).toBe(true)
  await click(dialog().querySelector('input[type="checkbox"]') as HTMLElement)
  expect(button('Trust and install')?.disabled).toBe(false)

  await click(button('Trust and install'))
  expect(installCalls).toEqual([{ trustToken: 'token-1', trustCode: true, workspaceRoot: '/Users/dev/project' }])
  expect(dialog().textContent).toContain('Installed Notes.')
})

test('signed code needs no second answer, and editing the URL starts over', async () => {
  resolveAnswer = {
    ok: true,
    trustToken: 'token-2',
    preview: preview({
      publisher: { name: 'Acme', verified: true },
      verify: { ...preview().verify, classification: 'verified', keyFingerprint: 'e'.repeat(64) },
    }),
  }
  await mount()
  await typeUrl('acme/notes-ext')
  await click(button('Review'))
  expect(dialog().textContent).not.toContain('I trust this code')
  expect(button('Install')?.disabled).toBe(false)

  await typeUrl('acme/other-ext')
  expect(button('Install')).toBeUndefined()
  expect(button('Review')).toBeTruthy()
})

test('a skill repository is sent to the skill-source path, with its URL', async () => {
  resolveAnswer = {
    ok: false,
    skillSource: true,
    message: 'This repository is an agent-CLI plugin (it has .claude-plugin/), not a SprintEngine extension.',
  }
  const added: string[] = []
  await mount({ onAddSkillSource: (url) => added.push(url) })
  await typeUrl('https://github.com/acme/skills')
  await click(button('Review'))
  expect(dialog().textContent).toContain('agent-CLI plugin')
  await click(button('Add it as a skill source instead'))
  expect(added).toEqual(['https://github.com/acme/skills'])
})

test('a refused install says why, and a bundle that writes into a project needs one open', async () => {
  resolveAnswer = { ok: true, trustToken: 'token-3', preview: preview({ provides: ['module', 'mcp'] }) }
  await mount({ workspaceRoot: null })
  await typeUrl('acme/notes-ext')
  await click(button('Review'))
  await click(dialog().querySelector('input[type="checkbox"]') as HTMLElement)
  expect(dialog().textContent).toContain('Open the project it is for')
  expect(button('Trust and install')?.disabled).toBe(true)
})

test('an installed copy is named, and what changed since its approval is spelled out', () => {
  expect(installedStateLine(preview())).toBeNull()
  expect(installedStateLine(preview({ installed: { version: 1, sha: 'b'.repeat(40), changes: [] } }))).toEqual({
    text: 'Notes version 1 at bbbbbbb is installed. This installs version 2 at a1b2c3d in its place.',
    changed: false,
  })
  const changed = installedStateLine(
    preview({ installed: { version: 1, sha: 'b'.repeat(40), changes: ['permissions', 'mcp'] } }),
  )
  expect(changed?.changed).toBe(true)
  expect(changed?.text).toContain('changes the access it requests, the MCP servers it adds')
})
