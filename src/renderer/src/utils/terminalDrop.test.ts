import assert from 'node:assert/strict'
import type { SkillPackHarness } from '../../../shared/electron-api'
import {
  backlogSlashCommandForDrop,
  formatDroppedPathsForTerminal,
  sendFileDropToTerminal,
  type FileDropPayload,
} from './terminalDrop'

function payload(path: string, rootPath = 'C:\\repo'): FileDropPayload {
  return {
    version: 1,
    workspaceId: 'workspace-1',
    rootPath,
    files: [{ path, name: path.split(/[/\\]/).at(-1) ?? path }],
  }
}

function directoryPayload(path: string, rootPath = 'C:\\repo'): FileDropPayload {
  return {
    version: 1,
    workspaceId: 'workspace-1',
    rootPath,
    files: [{ path, name: path.split(/[/\\]/).at(-1) ?? path, isDir: true }],
  }
}

function session(input: Partial<TerminalSessionSnapshot>): TerminalSessionSnapshot {
  return {
    sessionId: 'session-1',
    processAlive: true,
    kind: 'terminal',
    startedAt: 1,
    lastOutputAt: null,
    lastInputAt: null,
    lastVisibleAt: null,
    activity: { kind: 'idle', since: 1 },
    exitedAt: null,
    outputBufferLength: 0,
    retainedOutputBytes: 0,
    visible: true,
    ...input,
  }
}

assert.equal(
  formatDroppedPathsForTerminal(
    payload('C:\\repo\\src\\main.ts'),
    session({ cwd: 'C:\\repo', pathStyle: 'windows' })
  ),
  "'src\\main.ts'"
)

assert.equal(
  formatDroppedPathsForTerminal(
    payload('C:\\repo\\assets\\hero image.png'),
    session({ cwd: 'C:\\repo', pathStyle: 'wsl' })
  ),
  "'assets/hero image.png'"
)

assert.equal(
  formatDroppedPathsForTerminal(
    payload('C:\\Repo\\Assets\\HeroImage.PNG', 'C:\\Repo'),
    session({ cwd: 'C:\\Repo', pathStyle: 'wsl' })
  ),
  "'Assets/HeroImage.PNG'"
)

assert.equal(
  formatDroppedPathsForTerminal(
    payload('C:\\Repo\\Assets\\HeroImage.PNG', 'C:\\Repo'),
    session({ cwd: 'C:\\Repo', pathStyle: 'windows' })
  ),
  "'Assets\\HeroImage.PNG'"
)

assert.equal(
  formatDroppedPathsForTerminal(
    payload('/home/alex/repo/src/main.ts', '/home/alex/repo'),
    session({ cwd: '/home/alex/repo', pathStyle: 'posix' })
  ),
  "'src/main.ts'"
)

assert.equal(
  formatDroppedPathsForTerminal(
    directoryPayload('C:\\repo\\src\\renderer', 'C:\\repo'),
    session({ cwd: 'C:\\repo\\.worktrees\\agent-1', pathStyle: 'windows' })
  ),
  "'src\\renderer'"
)

assert.equal(
  formatDroppedPathsForTerminal(
    directoryPayload('/home/alex/repo/src/renderer', '/home/alex/repo'),
    session({ cwd: '/home/alex/repo/.worktrees/agent-1', pathStyle: 'posix' })
  ),
  "'src/renderer'"
)

assert.equal(
  formatDroppedPathsForTerminal(
    payload('C:\\other\\image.png'),
    session({ cwd: 'C:\\repo', pathStyle: 'wsl' })
  ),
  "'/mnt/c/other/image.png'"
)

assert.equal(
  formatDroppedPathsForTerminal(
    {
      version: 1,
      workspaceId: 'workspace-1',
      rootPath: '/repo',
      files: [
        { path: "/repo/it's.png", name: "it's.png" },
        { path: '/repo/two words.txt', name: 'two words.txt' },
      ],
    },
    session({ cwd: '/repo', pathStyle: 'posix' })
  ),
  `'it'"'"'s.png' 'two words.txt'`
)

assert.equal(
  formatDroppedPathsForTerminal(
    payload('/repo/bad\nname.txt', '/repo'),
    session({ cwd: '/repo', pathStyle: 'posix' })
  ),
  ''
)

// --- backlogSlashCommandForDrop -------------------------------------------

const allHarnesses = ['claude', 'codex', 'cursor', 'gemini', 'opencode', 'agents'] as const

function backlogPayload(path: string, rootPath = '/repo'): FileDropPayload {
  return payload(path, rootPath)
}

const agentSession = (input: Partial<TerminalSessionSnapshot> = {}): TerminalSessionSnapshot =>
  session({ kind: 'agent', cli: 'claude-code', executionMode: 'current_workspace', ...input })

assert.equal(
  backlogSlashCommandForDrop(backlogPayload('/repo/backlog/item.md'), agentSession(), allHarnesses),
  '/backlog backlog/item.md'
)

// Windows separators normalize to a forward-slash project-relative path.
assert.equal(
  backlogSlashCommandForDrop(
    backlogPayload('C:\\repo\\backlog\\item.md', 'C:\\repo'),
    agentSession({ pathStyle: 'windows' }),
    allHarnesses
  ),
  '/backlog backlog/item.md'
)

// Whitespace in the file name gets quoted.
assert.equal(
  backlogSlashCommandForDrop(backlogPayload('/repo/backlog/two words.md'), agentSession(), allHarnesses),
  "/backlog 'backlog/two words.md'"
)

// Codex maps to the codex harness.
assert.equal(
  backlogSlashCommandForDrop(
    backlogPayload('/repo/backlog/item.md'),
    agentSession({ cli: 'codex' }),
    ['codex']
  ),
  '/backlog backlog/item.md'
)

// Not an agent terminal.
assert.equal(
  backlogSlashCommandForDrop(
    backlogPayload('/repo/backlog/item.md'),
    session({ kind: 'terminal', cli: undefined }),
    allHarnesses
  ),
  null
)

// Worktree sessions keep plain path pastes.
assert.equal(
  backlogSlashCommandForDrop(
    backlogPayload('/repo/backlog/item.md'),
    agentSession({ executionMode: 'worktree', worktreePath: '/repo/.worktrees/a' }),
    allHarnesses
  ),
  null
)

// Unknown or shell CLIs never get a slash command.
assert.equal(
  backlogSlashCommandForDrop(
    backlogPayload('/repo/backlog/item.md'),
    agentSession({ cli: 'generic-shell' }),
    allHarnesses
  ),
  null
)

// The CLI's harness must actually have the skill present.
assert.equal(
  backlogSlashCommandForDrop(backlogPayload('/repo/backlog/item.md'), agentSession(), ['codex']),
  null
)

// Only single-file drops inject.
assert.equal(
  backlogSlashCommandForDrop(
    {
      version: 1,
      workspaceId: 'workspace-1',
      rootPath: '/repo',
      files: [
        { path: '/repo/backlog/a.md', name: 'a.md' },
        { path: '/repo/backlog/b.md', name: 'b.md' },
      ],
    },
    agentSession(),
    allHarnesses
  ),
  null
)

// Files outside backlog/ keep the plain path behavior.
assert.equal(
  backlogSlashCommandForDrop(backlogPayload('/repo/src/main.ts'), agentSession(), allHarnesses),
  null
)

// Directories and native drops (no workspace root) are excluded.
assert.equal(
  backlogSlashCommandForDrop(directoryPayload('/repo/backlog/sub', '/repo'), agentSession(), allHarnesses),
  null
)
assert.equal(
  backlogSlashCommandForDrop(backlogPayload('/repo/backlog/item.md', ''), agentSession(), allHarnesses),
  null
)

// --- sendFileDropToTerminal -------------------------------------------------

type TerminalWriteCall = { sessionId: string; data: string }

function bracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`
}

function installWindowApiStub(input: {
  sessions: TerminalSessionSnapshot[]
  backlogSkillHarnesses?: SkillPackHarness[]
}): TerminalWriteCall[] {
  const writes: TerminalWriteCall[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        terminalList: async () => input.sessions,
        terminalWrite: async (sessionId: string, data: string) => {
          writes.push({ sessionId, data })
        },
        builtinSkillStatus: async () => ({
          ok: true,
          status: 'installed',
          skill: { id: 'backlog', name: 'Backlog', version: '1.0.0', description: '' },
          destinationPath: '.agents/skills/backlog',
          installedVersion: '1.0.0',
          targets: (input.backlogSkillHarnesses ?? []).map((harness) => ({
            harness,
            destinationPath: '.agents/skills/backlog',
            status: 'installed' as const,
          })),
        }),
      },
    },
  })
  return writes
}

async function testSlashCapableAgentGetsBacklogCommand(): Promise<void> {
  const liveAgent = agentSession({ cwd: '/repo', pathStyle: 'posix' })
  const writes = installWindowApiStub({
    sessions: [liveAgent],
    backlogSkillHarnesses: ['claude'],
  })

  const sent = await sendFileDropToTerminal({
    payload: backlogPayload('/repo/backlog/item.md'),
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
  })

  assert.deepEqual(sent, { ok: true, text: '/backlog backlog/item.md' })
  assert.deepEqual(writes, [
    { sessionId: 'session-1', data: bracketedPaste('/backlog backlog/item.md') },
  ])
}

async function testNonSlashAgentGetsQuotedRelativePath(): Promise<void> {
  const shellAgent = agentSession({ cli: 'generic-shell', cwd: '/repo', pathStyle: 'posix' })
  const writes = installWindowApiStub({
    sessions: [shellAgent],
    backlogSkillHarnesses: ['claude'],
  })

  const sent = await sendFileDropToTerminal({
    payload: backlogPayload('/repo/backlog/item.md'),
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
  })

  assert.deepEqual(sent, { ok: true, text: "'backlog/item.md'" })
  assert.deepEqual(writes, [
    { sessionId: 'session-1', data: bracketedPaste("'backlog/item.md'") },
  ])
}

async function testWorktreeSessionGetsPlainPathNeverBacklog(): Promise<void> {
  const worktreeAgent = agentSession({
    executionMode: 'worktree',
    worktreePath: '/repo/.worktrees/a',
    cwd: '/repo/.worktrees/a',
    pathStyle: 'posix',
  })
  const writes = installWindowApiStub({
    sessions: [worktreeAgent],
    backlogSkillHarnesses: ['claude'],
  })

  const sent = await sendFileDropToTerminal({
    payload: backlogPayload('/repo/backlog/item.md'),
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
  })

  assert.deepEqual(sent, { ok: true, text: "'/repo/backlog/item.md'" })
  assert.deepEqual(writes, [
    { sessionId: 'session-1', data: bracketedPaste("'/repo/backlog/item.md'") },
  ])
}

async function testDeadSessionReturnsExplicitError(): Promise<void> {
  const deadAgent = agentSession({ processAlive: false, cwd: '/repo', pathStyle: 'posix' })
  const writes = installWindowApiStub({
    sessions: [deadAgent],
    backlogSkillHarnesses: ['claude'],
  })

  const sent = await sendFileDropToTerminal({
    payload: backlogPayload('/repo/backlog/item.md'),
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
  })

  assert.deepEqual(sent, { ok: false, message: 'Terminal session is no longer running.' })
  assert.deepEqual(writes, [])
}

async function testWorkspaceMismatchRejectsBeforeWrite(): Promise<void> {
  const writes = installWindowApiStub({
    sessions: [agentSession({ cwd: '/repo', pathStyle: 'posix' })],
    backlogSkillHarnesses: ['claude'],
  })

  const sent = await sendFileDropToTerminal({
    payload: backlogPayload('/repo/backlog/item.md'),
    sessionId: 'session-1',
    workspaceId: 'workspace-2',
  })

  assert.deepEqual(sent, {
    ok: false,
    message: 'Drop files into a terminal from the same workspace.',
  })
  assert.deepEqual(writes, [])
}

void testSlashCapableAgentGetsBacklogCommand()
  .then(testNonSlashAgentGetsQuotedRelativePath)
  .then(testWorktreeSessionGetsPlainPathNeverBacklog)
  .then(testDeadSessionReturnsExplicitError)
  .then(testWorkspaceMismatchRejectsBeforeWrite)
