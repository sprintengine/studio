// @vitest-environment jsdom
import React, { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { InstalledSkill, InstalledSkillsResult } from '../../../../shared/installed-skills'
import type { TerminalSessionSnapshot } from '../../../../shared/electron-api'
import { InstalledSkillsPanel, pickSkillsCli, type InstalledSkillsPanelHandle } from './InstalledSkillsPanel'

type FixtureSession = Partial<TerminalSessionSnapshot> & { sessionId: string }

const fixtures = vi.hoisted(() => ({
  state: {
    pluginCatalogEntries: [
      { id: 'codex', displayName: 'Codex', skillIntegration: { support: 'native' } },
      { id: 'claude-code', displayName: 'Claude Code', skillIntegration: { support: 'native' } },
      { id: 'generic-shell', displayName: 'Shell', skillIntegration: { support: 'unsupported' } },
    ],
    cliAvailability: {} as Record<string, { installed: boolean }>,
    appSettings: { cliRuntimes: {}, lastSelectedCli: 'claude-code' },
    focusedAgentByWorkspaceId: { workspace: 'agent' } as Record<string, string>,
    workspaces: [] as Array<{ id: string; hostId?: string }>,
  },
  sessions: [] as FixtureSession[],
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
function skill(index: number, scope: InstalledSkill['scope'], name = `skill-${String(index).padStart(2, '0')}`) {
  return {
    id: `installation-${scope}-${index}`,
    name,
    description: 'Skill description',
    path: scope === 'global' ? `/Users/dev/.codex/skills/${name}` : `/Users/dev/project/.codex/skills/${name}`,
    scope,
    origin: 'Codex',
    linked: false,
    removable: true,
  } satisfies InstalledSkill
}
// A global and a project copy under one name, plus seven more project skills.
const rows: InstalledSkill[] = [
  skill(0, 'global', 'duplicate'),
  skill(1, 'project', 'duplicate'),
  ...Array.from({ length: 7 }, (_, index) => skill(index + 2, 'project')),
]

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
  fixtures.state.focusedAgentByWorkspaceId = { workspace: 'agent' }
  fixtures.state.cliAvailability = {}
  fixtures.sessions = [
    {
      sessionId: 'session',
      agentId: 'agent',
      workspaceId: 'workspace',
      kind: 'agent',
      cli: 'codex',
      processAlive: true,
      cwd: '/Users/dev/project',
      startedAt: 1,
      lastInputAt: null,
    },
  ]
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

// Stands in for the palette: its one field, whose keys the panel sees first.
function Palette({ query }: { query: string }) {
  const field = useRef<HTMLInputElement>(null)
  const panel = useRef<InstalledSkillsPanelHandle>(null)
  return (
    <>
      <input
        ref={field}
        value={query}
        readOnly
        onKeyDown={(event) => {
          if (panel.current?.handleKey(event)) return
          if (event.key === 'Backspace' && !query) back()
        }}
      />
      <InstalledSkillsPanel
        ref={panel}
        query={query}
        fieldRef={field}
        workspaceRoot="/Users/dev/project"
        workspaceId="workspace"
        preferredTarget={null}
        onBrowse={() => {}}
        onUsed={used}
      />
    </>
  )
}
async function render(query = '') {
  await act(async () => root.render(<Palette query={query} />))
}
const field = () => host.querySelector('input')!
const options = () => Array.from(host.querySelectorAll('[role="option"]'))
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

test('lists the focused CLI’s installations under the palette’s field, Project before Global', async () => {
  await render()
  expect(list).toHaveBeenCalledWith({ workspaceRoot: '/Users/dev/project', pluginId: 'codex' })
  // No second field and no CLI picker: the palette's field is the only control that filters.
  expect(host.querySelectorAll('input')).toHaveLength(1)
  expect(host.querySelector('[role="combobox"]')).toBeNull()
  expect(host.textContent).toContain('Codex skills')
  expect(options()).toHaveLength(9)
  const groups = Array.from(host.querySelectorAll('[role="group"]')).map((group) => group.getAttribute('aria-label'))
  expect(groups).toEqual(['Project skills', 'Global skills'])
  expect(host.querySelector('[aria-label="Global skills"]')?.textContent).toContain('duplicate')
  expect(document.activeElement).toBe(field())
})

test('the palette’s query filters the inventory', async () => {
  await render('skill-03')
  expect(options().map((option) => option.textContent)).toEqual([expect.stringContaining('skill-03')])
  expect(host.querySelector('[aria-label="Global skills"]')?.textContent).toContain('No matching skills.')
})

test('each scope shows ten rows and a Show more row the keyboard reaches; a new query folds it back', async () => {
  list.mockResolvedValue({
    ok: true,
    skills: [
      ...Array.from({ length: 23 }, (_, index) => skill(index, 'project')),
      ...Array.from({ length: 12 }, (_, index) => skill(index, 'global')),
    ],
    diagnostics: [],
  })
  await render()
  const project = () => host.querySelector('[aria-label="Project skills"]')!
  const global = () => host.querySelector('[aria-label="Global skills"]')!
  expect(project().querySelectorAll('[role="option"]')).toHaveLength(11)
  expect(global().querySelectorAll('[role="option"]')).toHaveLength(11)
  expect(project().textContent).toContain('Show more · 13 more')
  for (let step = 0; step < 10; step += 1) await key(field(), 'ArrowDown')
  const more = host.querySelector('[aria-selected="true"]')!
  expect(more.textContent).toContain('Show more')
  await key(field(), 'Enter')
  // Only that scope grew, and the cursor is on the first row it revealed.
  expect(project().querySelectorAll('[role="option"]')).toHaveLength(21)
  expect(global().querySelectorAll('[role="option"]')).toHaveLength(11)
  expect(host.querySelector('[aria-selected="true"]')?.textContent).toContain('skill-10')
  await act(async () => (project().querySelector('[id="installed-skills-more-project"]') as HTMLElement).click())
  expect(project().querySelectorAll('[role="option"]')).toHaveLength(23)
  expect(project().textContent).not.toContain('Show more')
  await render('skill')
  expect(project().querySelectorAll('[role="option"]')).toHaveLength(11)
})

test('keyboard opens details and Escape returns to the list and the field', async () => {
  await render()
  await key(field(), 'Enter')
  expect(host.textContent).toContain('Use in agent')
  await key(host.querySelector('section')!, 'Escape')
  expect(options()).toHaveLength(9)
  expect(document.activeElement).toBe(field())
})

test('removal requires explicit confirmation and targets the displayed installation', async () => {
  await render()
  await act(async () => (host.querySelector('[aria-label="Global skills"] [role="option"]') as HTMLElement).click())
  await click('Remove…')
  expect(remove).not.toHaveBeenCalled()
  expect(host.textContent).toContain('every project')
  await click('Move to Trash')
  expect(remove).toHaveBeenCalledWith({
    workspaceRoot: '/Users/dev/project',
    pluginId: 'codex',
    installationId: 'installation-global-0',
  })
  expect(list).toHaveBeenCalledTimes(2)
})

test('using a global duplicate pastes its exact path without attaching or reinstalling', async () => {
  await render()
  await act(async () => (host.querySelector('[aria-label="Global skills"] [role="option"]') as HTMLElement).click())
  await click('Use in agent')
  expect(write).toHaveBeenCalledWith('session', expect.stringContaining('/Users/dev/.codex/skills/duplicate/SKILL.md'))
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
  expect(options()).toHaveLength(0)
  expect(host.textContent).toContain('Reading installed skills')
  expect(host.textContent).toContain('Claude Code skills')
  await act(async () => complete({ ok: true, skills: [], diagnostics: [] }))
  expect(host.textContent).toContain('No skills installed here.')
})

test('with no agent in focus the most recent agent’s CLI is listed, not an empty prompt', async () => {
  fixtures.state.focusedAgentByWorkspaceId = {}
  fixtures.sessions[0].cli = 'claude-code'
  await render()
  expect(list).toHaveBeenCalledWith({ workspaceRoot: '/Users/dev/project', pluginId: 'claude-code' })
  expect(host.textContent).toContain('Claude Code skills')
})

test('a Claude Code session running in WSL asks main for its WSL-side skills', async () => {
  fixtures.sessions[0].cli = 'claude-code'
  fixtures.sessions[0].pathStyle = 'wsl'
  await render()
  expect(list).toHaveBeenCalledWith({ workspaceRoot: '/Users/dev/project', pluginId: 'claude-code', pathStyle: 'wsl' })
  expect(host.textContent).toContain('Claude Code skills in WSL')
})

test("a session on a named WSL machine asks for that distribution's skills", async () => {
  fixtures.sessions[0].cli = 'claude-code'
  fixtures.sessions[0].pathStyle = 'wsl'
  ;(fixtures.sessions[0] as { hostId?: string }).hostId = 'wsl:Ubuntu'
  await render()
  expect(list).toHaveBeenCalledWith({
    workspaceRoot: '/Users/dev/project',
    pluginId: 'claude-code',
    pathStyle: 'wsl',
    hostId: 'wsl:Ubuntu',
  })
})

test('read failures stay visible instead of claiming no skills are installed', async () => {
  list.mockResolvedValue({ ok: false, message: 'Permission denied' })
  await render()
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Permission denied')
  expect(host.textContent).not.toContain('No skills installed here.')
})

test('Backspace is left to the palette, which steps back to All', async () => {
  await render()
  await key(field(), 'Backspace')
  expect(back).toHaveBeenCalledTimes(1)
})

test('closing during the installation recheck cancels a pending paste', async () => {
  await render()
  await key(field(), 'Enter')
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

test('the CLI falls back from focus to recent agents to the only installed CLI', () => {
  const agent = (cli: string, workspaceId: string, lastInputAt: number) =>
    ({
      sessionId: `${cli}-${workspaceId}`,
      kind: 'agent',
      cli,
      workspaceId,
      startedAt: 0,
      lastInputAt,
    }) as TerminalSessionSnapshot
  const base = {
    focused: undefined,
    preferredCli: undefined,
    workspaceId: 'workspace',
    supported: ['codex', 'claude-code'],
    installed: () => false,
    lastSelectedCli: undefined,
  }
  // This workspace's agent wins over a more recent one elsewhere.
  expect(
    pickSkillsCli({ ...base, sessions: [agent('codex', 'other', 9), agent('claude-code', 'workspace', 1)] }).pluginId,
  ).toBe('claude-code')
  // A CLI that reads no skills is never the fallback.
  expect(pickSkillsCli({ ...base, sessions: [agent('cursor', 'workspace', 9)] }).pluginId).toBe('')
  expect(pickSkillsCli({ ...base, sessions: [], installed: (id) => id === 'claude-code' }).pluginId).toBe('claude-code')
  expect(pickSkillsCli({ ...base, sessions: [], installed: () => true, lastSelectedCli: 'codex' }).pluginId).toBe(
    'codex',
  )
  // The agent in focus answers outright, even for a CLI without skills.
  expect(pickSkillsCli({ ...base, sessions: [], focused: agent('cursor', 'workspace', 0) }).pluginId).toBe('cursor')
})
