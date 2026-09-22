// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { InstalledSkill, InstalledSkillsResult } from '../../../../shared/installed-skills'
import { InstalledSkillsPanel } from './InstalledSkillsPanel'

const fixtures = vi.hoisted(() => ({
  state: {
    pluginCatalogEntries: [
      { id: 'codex', displayName: 'Codex', skillIntegration: { support: 'native' } },
      { id: 'claude-code', displayName: 'Claude Code', skillIntegration: { support: 'native' } },
    ],
    focusedAgentByWorkspaceId: { workspace: 'agent' },
  },
  sessions: [
    {
      sessionId: 'session',
      agentId: 'agent',
      workspaceId: 'workspace',
      kind: 'agent',
      cli: 'codex',
      processAlive: true,
      cwd: '/project',
    },
  ],
}))
vi.mock('../../store/workspaceStore', () => ({
  useWorkspaceStore: (select: (state: typeof fixtures.state) => unknown) => select(fixtures.state),
}))
vi.mock('../../hooks/useTerminalSessions', () => ({ useTerminalSessions: () => fixtures.sessions }))

let root: Root
let host: HTMLDivElement
const list = vi.fn<(input: unknown) => Promise<InstalledSkillsResult>>()
const remove = vi.fn().mockResolvedValue({ ok: true })
const write = vi.fn().mockResolvedValue(undefined)
const used = vi.fn()
const back = vi.fn()
const rows: InstalledSkill[] = Array.from({ length: 9 }, (_, index) => ({
  id: `installation-${index}`,
  name: index < 2 ? 'duplicate' : `skill-${index}`,
  description: 'Skill description',
  path: index === 0 ? '/home/.codex/skills/duplicate' : `/project/.codex/skills/skill-${index}`,
  scope: index === 0 ? 'global' : 'project',
  origin: 'Codex',
  linked: false,
  removable: true,
}))

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  HTMLElement.prototype.scrollIntoView = vi.fn()
  list.mockResolvedValue({ ok: true, skills: rows, diagnostics: [] })
  Object.assign(window, {
    api: {
      installedSkillsList: list,
      installedSkillRemove: remove,
      terminalList: async () => fixtures.sessions,
      terminalWrite: write,
      showItemInFolder: vi.fn(),
    },
  })
  fixtures.sessions[0].cli = 'codex'
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function render() {
  await act(async () =>
    root.render(
      <InstalledSkillsPanel
        workspaceRoot="/project"
        workspaceId="workspace"
        preferredTarget={null}
        onBrowse={() => {}}
        onBack={back}
        onUsed={used}
      />,
    ),
  )
}
async function click(text: string) {
  const button = Array.from(host.querySelectorAll('button')).find((node) => node.textContent === text)
  expect(button).toBeTruthy()
  await act(async () => button!.click())
}
async function key(element: Element, value: string) {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
  })
}

test('shows every installation immediately, grouped by scope for the focused CLI', async () => {
  await render()
  expect(list).toHaveBeenCalledWith({ workspaceRoot: '/project', pluginId: 'codex' })
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(9)
  expect(host.querySelector('[aria-label="Project skills"]')?.textContent).toContain('duplicate')
  expect(host.querySelector('[aria-label="Global skills"]')?.textContent).toContain('duplicate')
  expect(document.activeElement).toBe(host.querySelector('input'))
})

test('keyboard opens details and Escape returns without closing the palette', async () => {
  await render()
  await key(host.querySelector('input')!, 'Enter')
  expect(host.textContent).toContain('Use in agent')
  await key(host.querySelector('section')!, 'Escape')
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(9)
  expect(document.activeElement).toBe(host.querySelector('input'))
})

test('removal requires explicit confirmation and targets the displayed installation', async () => {
  await render()
  await act(async () => (host.querySelector('[aria-label="Global skills"] [role="option"]') as HTMLElement).click())
  await click('Remove…')
  expect(remove).not.toHaveBeenCalled()
  expect(host.textContent).toContain('every project')
  await click('Move to Trash')
  expect(remove).toHaveBeenCalledWith({
    workspaceRoot: '/project',
    pluginId: 'codex',
    installationId: 'installation-0',
  })
  expect(list).toHaveBeenCalledTimes(2)
})

test('using a global duplicate pastes its exact path without attaching or reinstalling', async () => {
  await render()
  await act(async () => (host.querySelector('[aria-label="Global skills"] [role="option"]') as HTMLElement).click())
  await click('Use in agent')
  expect(write).toHaveBeenCalledWith('session', expect.stringContaining('/home/.codex/skills/duplicate/SKILL.md'))
  expect(used).toHaveBeenCalledTimes(1)
})

test('switching focused CLIs clears the old inventory while the next read is pending', async () => {
  await render()
  let complete!: (value: InstalledSkillsResult) => void
  list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  fixtures.sessions[0].cli = 'claude-code'
  await render()
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(0)
  expect(host.textContent).toContain('Reading installed skills')
  await act(async () => complete({ ok: true, skills: [], diagnostics: [] }))
  expect(host.textContent).toContain('No skills installed here.')
})

test('read failures stay visible instead of claiming no skills are installed', async () => {
  list.mockResolvedValue({ ok: false, message: 'Permission denied' })
  await render()
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Permission denied')
  expect(host.textContent).not.toContain('No skills installed here.')
})

test('Backspace at an empty filter returns to All', async () => {
  await render()
  await key(host.querySelector('input')!, 'Backspace')
  expect(back).toHaveBeenCalledTimes(1)
})

test('closing during the installation recheck cancels a pending paste', async () => {
  await render()
  await key(host.querySelector('input')!, 'Enter')
  let complete!: (value: InstalledSkillsResult) => void
  list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  await click('Use in agent')
  await act(async () => root.render(null))
  await act(async () => complete({ ok: true, skills: rows, diagnostics: [] }))
  expect(write).not.toHaveBeenCalled()
})
