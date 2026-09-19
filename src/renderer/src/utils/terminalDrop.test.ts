import assert from 'node:assert/strict'
import type { SkillHarness } from '../../../shared/electron-api'
import type { PluginRegistryListEntry } from '../../../shared/plugin-manifest'
import { plainSkillInvocation, resolveSkillInvocation } from '../../../shared/skill-invocation'
import {
  backlogItemDropDescriptor,
  backlogSkillInvocationForDrop,
  formatDroppedPathsForTerminal,
  hasSkillDropData,
  MULTICODE_FILE_DROP_MIME,
  MULTICODE_SKILL_DROP_MIME,
  pasteDroppedSkillIntoTerminal,
  sendFileDropToTerminal,
  sendSkillToTerminal,
  setSkillDropData,
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
    suspended: false,
    fileChanges: [],
    activeSubagents: 0,
    contextUsage: null,
    reapExempt: false,
    ...input,
  }
}

assert.equal(
  formatDroppedPathsForTerminal(payload('C:\\repo\\src\\main.ts'), session({ cwd: 'C:\\repo', pathStyle: 'windows' })),
  "'src\\main.ts'",
)

assert.equal(
  formatDroppedPathsForTerminal(
    payload('C:\\repo\\assets\\hero image.png'),
    session({ cwd: 'C:\\repo', pathStyle: 'wsl' }),
  ),
  "'assets/hero image.png'",
)

assert.equal(
  formatDroppedPathsForTerminal(
    payload('C:\\Repo\\Assets\\HeroImage.PNG', 'C:\\Repo'),
    session({ cwd: 'C:\\Repo', pathStyle: 'wsl' }),
  ),
  "'Assets/HeroImage.PNG'",
)

assert.equal(
  formatDroppedPathsForTerminal(
    payload('C:\\Repo\\Assets\\HeroImage.PNG', 'C:\\Repo'),
    session({ cwd: 'C:\\Repo', pathStyle: 'windows' }),
  ),
  "'Assets\\HeroImage.PNG'",
)

assert.equal(
  formatDroppedPathsForTerminal(
    payload('/home/alex/repo/src/main.ts', '/home/alex/repo'),
    session({ cwd: '/home/alex/repo', pathStyle: 'posix' }),
  ),
  "'src/main.ts'",
)

assert.equal(
  formatDroppedPathsForTerminal(
    directoryPayload('C:\\repo\\src\\renderer', 'C:\\repo'),
    session({ cwd: 'C:\\repo\\.worktrees\\agent-1', pathStyle: 'windows' }),
  ),
  "'src\\renderer'",
)

assert.equal(
  formatDroppedPathsForTerminal(
    directoryPayload('/home/alex/repo/src/renderer', '/home/alex/repo'),
    session({ cwd: '/home/alex/repo/.worktrees/agent-1', pathStyle: 'posix' }),
  ),
  "'src/renderer'",
)

assert.equal(
  formatDroppedPathsForTerminal(payload('C:\\other\\image.png'), session({ cwd: 'C:\\repo', pathStyle: 'wsl' })),
  "'/mnt/c/other/image.png'",
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
    session({ cwd: '/repo', pathStyle: 'posix' }),
  ),
  `'it'"'"'s.png' 'two words.txt'`,
)

assert.equal(
  formatDroppedPathsForTerminal(payload('/repo/bad\nname.txt', '/repo'), session({ cwd: '/repo', pathStyle: 'posix' })),
  '',
)

// --- backlogSkillInvocationForDrop ----------------------------------------

const allHarnesses = ['claude', 'codex', 'cursor', 'gemini', 'opencode', 'agents'] as const
const pluginEntries: PluginRegistryListEntry[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    source: 'bundled',
    version: 1,
    binary: 'claude',
    resumeSession: true,
    sessionIdFromCaller: true,
    agentStateCapable: true,
    skillIntegration: {
      support: 'native',
      harnessId: 'claude',
      installTargets: [
        {
          scope: 'workspace',
          path: '{{workspaceRoot}}/.claude/skills/{{skillId}}',
          format: 'claude-code',
          restartRequired: true,
        },
      ],
      invocation: { fileDropTemplate: '/{{skillId}} {{path}}', nativeSlashCommand: true },
    },
  },
  {
    id: 'codex',
    displayName: 'Codex',
    source: 'bundled',
    version: 1,
    binary: 'codex',
    resumeSession: true,
    sessionIdFromCaller: false,
    agentStateCapable: true,
    skillIntegration: {
      support: 'native',
      harnessId: 'codex',
      installTargets: [
        {
          scope: 'workspace',
          path: '{{workspaceRoot}}/.codex/skills/{{skillId}}',
          format: 'codex',
          restartRequired: true,
        },
      ],
      invocation: { fileDropTemplate: 'Use ${{skillId}} to work {{path}}.', explicitMention: true },
    },
  },
  {
    id: 'pi',
    displayName: 'Pi',
    source: 'user',
    version: 1,
    binary: 'pi',
    resumeSession: false,
    sessionIdFromCaller: false,
    agentStateCapable: true,
    skillIntegration: {
      support: 'native',
      harnessId: 'pi',
      installTargets: [
        {
          scope: 'workspace',
          path: '{{workspaceRoot}}/.pi/skills/{{skillId}}',
          format: 'generic',
          restartRequired: false,
        },
      ],
      invocation: { fileDropTemplate: 'pi-skill {{skillId}} {{path}}' },
    },
  },
  {
    id: 'generic-shell',
    displayName: 'Generic Shell',
    source: 'bundled',
    version: 1,
    binary: 'sh',
    resumeSession: false,
    sessionIdFromCaller: false,
    agentStateCapable: true,
    skillIntegration: {
      support: 'unsupported',
      harnessId: 'generic-shell',
      installTargets: [],
    },
  },
]

function backlogPayload(path: string, rootPath = '/repo'): FileDropPayload {
  return payload(path, rootPath)
}

const agentSession = (input: Partial<TerminalSessionSnapshot> = {}): TerminalSessionSnapshot =>
  session({ kind: 'agent', cli: 'claude-code', executionMode: 'current_workspace', ...input })

// The fixture plugins, with the skill installed for exactly these harnesses.
const invocationFor = (
  drop: FileDropPayload,
  target: TerminalSessionSnapshot,
  installedHarnesses: readonly SkillHarness[],
): string | null =>
  backlogSkillInvocationForDrop(
    drop,
    target,
    pluginEntries,
    installedHarnesses.map((harness) => ({ harness, status: 'installed' as const, support: 'native' as const })),
  )

assert.equal(
  invocationFor(backlogPayload('/repo/backlog/item.md'), agentSession(), allHarnesses),
  '/backlog backlog/item.md',
)

assert.equal(
  backlogSkillInvocationForDrop(backlogPayload('/repo/backlog/item.md'), agentSession(), pluginEntries, [
    { harness: 'claude', status: 'installed', support: 'native', pluginId: 'claude-code' },
  ]),
  '/backlog backlog/item.md',
)

// Windows separators normalize to a forward-slash project-relative path.
assert.equal(
  invocationFor(
    backlogPayload('C:\\repo\\backlog\\item.md', 'C:\\repo'),
    agentSession({ pathStyle: 'windows' }),
    allHarnesses,
  ),
  '/backlog backlog/item.md',
)

// Whitespace in the file name gets quoted.
assert.equal(
  invocationFor(backlogPayload('/repo/backlog/two words.md'), agentSession(), allHarnesses),
  "/backlog 'backlog/two words.md'",
)

// Codex maps to the codex adapter, but not to a top-level `/backlog` command.
assert.equal(
  invocationFor(backlogPayload('/repo/backlog/item.md'), agentSession({ cli: 'codex' }), ['codex']),
  'Use $backlog to work backlog/item.md.',
)

assert.equal(
  backlogSkillInvocationForDrop(
    backlogPayload('/repo/backlog/item.md'),
    agentSession({ cli: 'codex' }),
    pluginEntries,
    [{ harness: 'codex', status: 'installed', support: 'native', pluginId: 'codex' }],
  ),
  'Use $backlog to work backlog/item.md.',
)

// Custom CLI plugins get their invocation from the manifest, not from app source.
assert.equal(
  backlogSkillInvocationForDrop(backlogPayload('/repo/backlog/item.md'), agentSession({ cli: 'pi' }), pluginEntries, [
    { harness: 'pi', status: 'installed', support: 'native', pluginId: 'pi' },
  ]),
  'pi-skill backlog backlog/item.md',
)

// Not an agent terminal.
assert.equal(
  invocationFor(backlogPayload('/repo/backlog/item.md'), session({ kind: 'terminal', cli: undefined }), allHarnesses),
  null,
)

// Worktree sessions keep plain path pastes.
assert.equal(
  invocationFor(
    backlogPayload('/repo/backlog/item.md'),
    agentSession({ executionMode: 'worktree', worktreePath: '/repo/.worktrees/a' }),
    allHarnesses,
  ),
  null,
)

// Unknown or shell CLIs never get a slash command.
assert.equal(
  invocationFor(backlogPayload('/repo/backlog/item.md'), agentSession({ cli: 'generic-shell' }), allHarnesses),
  null,
)

assert.equal(
  backlogSkillInvocationForDrop(
    backlogPayload('/repo/backlog/item.md'),
    agentSession({ cli: 'generic-shell' }),
    pluginEntries,
    [{ harness: 'generic-shell', status: 'unsupported', support: 'unsupported', pluginId: 'generic-shell' }],
  ),
  null,
)

// The CLI's harness must actually have the skill present.
assert.equal(invocationFor(backlogPayload('/repo/backlog/item.md'), agentSession(), ['codex']), null)

// Only single-file drops inject.
assert.equal(
  invocationFor(
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
    allHarnesses,
  ),
  null,
)

// Files outside backlog/ keep the plain path behavior.
assert.equal(invocationFor(backlogPayload('/repo/src/main.ts'), agentSession(), allHarnesses), null)

// Directories and native drops (no workspace root) are excluded.
assert.equal(invocationFor(directoryPayload('/repo/backlog/sub', '/repo'), agentSession(), allHarnesses), null)
assert.equal(invocationFor(backlogPayload('/repo/backlog/item.md', ''), agentSession(), allHarnesses), null)

// --- sendFileDropToTerminal -------------------------------------------------

type TerminalWriteCall = { sessionId: string; data: string }

function bracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`
}

function installWindowApiStub(input: {
  sessions: TerminalSessionSnapshot[]
  backlogSkillHarnesses?: SkillHarness[]
  plugins?: PluginRegistryListEntry[]
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
            support: 'native' as const,
          })),
        }),
        pluginsList: async () => ({
          ok: true as const,
          plugins: input.plugins ?? pluginEntries,
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
    plugins: pluginEntries,
  })

  const sent = await sendFileDropToTerminal({
    payload: backlogPayload('/repo/backlog/item.md'),
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
  })

  assert.deepEqual(sent, { ok: true, text: '/backlog backlog/item.md' })
  assert.deepEqual(writes, [{ sessionId: 'session-1', data: bracketedPaste('/backlog backlog/item.md') }])
}

async function testNonSlashAgentGetsQuotedRelativePath(): Promise<void> {
  const shellAgent = agentSession({ cli: 'generic-shell', cwd: '/repo', pathStyle: 'posix' })
  const writes = installWindowApiStub({
    sessions: [shellAgent],
    backlogSkillHarnesses: ['claude'],
    plugins: pluginEntries,
  })

  const sent = await sendFileDropToTerminal({
    payload: backlogPayload('/repo/backlog/item.md'),
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
  })

  assert.deepEqual(sent, { ok: true, text: "'backlog/item.md'" })
  assert.deepEqual(writes, [{ sessionId: 'session-1', data: bracketedPaste("'backlog/item.md'") }])
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
    plugins: pluginEntries,
  })

  const sent = await sendFileDropToTerminal({
    payload: backlogPayload('/repo/backlog/item.md'),
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
  })

  assert.deepEqual(sent, { ok: true, text: "'/repo/backlog/item.md'" })
  assert.deepEqual(writes, [{ sessionId: 'session-1', data: bracketedPaste("'/repo/backlog/item.md'") }])
}

async function testDeadSessionReturnsExplicitError(): Promise<void> {
  const deadAgent = agentSession({ processAlive: false, cwd: '/repo', pathStyle: 'posix' })
  const writes = installWindowApiStub({
    sessions: [deadAgent],
    backlogSkillHarnesses: ['claude'],
    plugins: pluginEntries,
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

// The link-recording gate: only a single backlog/ file handed to an agent
// session that carries an agent id yields a recordable handoff descriptor.
function testBacklogItemDropDescriptorGate(): void {
  assert.deepEqual(
    backlogItemDropDescriptor(backlogPayload('/repo/backlog/item.md'), agentSession({ agentId: 'agent-7' })),
    { relativePath: 'backlog/item.md', agentId: 'agent-7', workspaceRoot: '/repo' },
  )
  // No agent id to link to → not a recordable handoff (but a paste still works).
  assert.equal(backlogItemDropDescriptor(backlogPayload('/repo/backlog/item.md'), agentSession()), null)
  // Worktree agent: plain-path paste only, never a link (would fork the store).
  assert.equal(
    backlogItemDropDescriptor(
      backlogPayload('/repo/backlog/item.md'),
      agentSession({ agentId: 'agent-7', executionMode: 'worktree', worktreePath: '/repo/.worktrees/a' }),
    ),
    null,
  )
  // Plain terminal (not an agent).
  assert.equal(
    backlogItemDropDescriptor(backlogPayload('/repo/backlog/item.md'), session({ agentId: 'agent-7' })),
    null,
  )
  // Non-backlog path.
  assert.equal(
    backlogItemDropDescriptor(backlogPayload('/repo/src/main.ts'), agentSession({ agentId: 'agent-7' })),
    null,
  )
  // Multi-file drop is not a single-item handoff.
  assert.equal(
    backlogItemDropDescriptor(
      {
        version: 1,
        workspaceId: 'workspace-1',
        rootPath: '/repo',
        files: [
          { path: '/repo/backlog/a.md', name: 'a.md' },
          { path: '/repo/backlog/b.md', name: 'b.md' },
        ],
      },
      agentSession({ agentId: 'agent-7' }),
    ),
    null,
  )
}

// A successful send to an agent session carries the handoff descriptor so the
// caller can record the item ↔ agent link on both sides.
async function testHandoffDescriptorRidesResult(): Promise<void> {
  const liveAgent = agentSession({ agentId: 'agent-7', cwd: '/repo', pathStyle: 'posix' })
  installWindowApiStub({ sessions: [liveAgent], backlogSkillHarnesses: ['claude'], plugins: pluginEntries })

  const sent = await sendFileDropToTerminal({
    payload: backlogPayload('/repo/backlog/item.md'),
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
  })

  assert.deepEqual(sent, {
    ok: true,
    text: '/backlog backlog/item.md',
    backlog: { relativePath: 'backlog/item.md', agentId: 'agent-7', workspaceRoot: '/repo' },
  })
}

// --- sendSkillToTerminal ----------------------------------------------------
//
// The pane's two entry points — the drag onto a terminal and the row's Use
// action — are this one function, so what it renders IS what both do. The
// templates below are copied from the real manifests under resources/plugins.

const skillPluginEntries: PluginRegistryListEntry[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    source: 'bundled',
    version: 1,
    binary: 'claude',
    resumeSession: true,
    sessionIdFromCaller: true,
    agentStateCapable: true,
    skillIntegration: {
      support: 'native',
      harnessId: 'claude',
      installTargets: [],
      invocation: { explicitTemplate: '/{{skillId}}', nativeSlashCommand: true },
    },
  },
  {
    id: 'grok',
    displayName: 'Grok',
    source: 'bundled',
    version: 1,
    binary: 'grok',
    resumeSession: true,
    sessionIdFromCaller: false,
    agentStateCapable: true,
    skillIntegration: {
      support: 'native',
      harnessId: 'grok',
      installTargets: [],
      invocation: { explicitTemplate: '/{{skillId}}', nativeSlashCommand: true },
    },
  },
  {
    id: 'codex',
    displayName: 'Codex',
    source: 'bundled',
    version: 1,
    binary: 'codex',
    resumeSession: true,
    sessionIdFromCaller: false,
    agentStateCapable: true,
    skillIntegration: {
      support: 'native',
      harnessId: 'codex',
      installTargets: [],
      invocation: { explicitTemplate: 'Use ${{skillId}}.', explicitMention: true, implicitInvocation: true },
    },
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    source: 'bundled',
    version: 1,
    binary: 'opencode',
    resumeSession: true,
    sessionIdFromCaller: false,
    agentStateCapable: true,
    skillIntegration: {
      support: 'native',
      harnessId: 'opencode',
      installTargets: [],
      invocation: {
        explicitTemplate: 'Use the {{skillId}} skill.',
        explicitMention: true,
        implicitInvocation: true,
      },
    },
  },
  // Declares an MCP config and no skill integration at all — a different answer
  // from `unsupported`, and the plain mention is what it gets.
  {
    id: 'cursor',
    displayName: 'Cursor',
    source: 'bundled',
    version: 1,
    binary: 'cursor-agent',
    resumeSession: true,
    sessionIdFromCaller: false,
    agentStateCapable: true,
  },
  {
    id: 'generic-shell',
    displayName: 'Generic Shell',
    source: 'bundled',
    version: 1,
    binary: 'sh',
    resumeSession: false,
    sessionIdFromCaller: false,
    agentStateCapable: true,
    skillIntegration: { support: 'unsupported', harnessId: 'generic-shell', installTargets: [] },
  },
]

// The capability resolver's answer for one CLI, from the same two declarations
// the real one reads: the harness directories the skill is in, and the plugin's
// own invocation template. Standing in for it here — rather than for the
// workspace inventory this path used to consult — is what keeps a CLI added by
// manifest alone on the same footing as the bundled ones.
function stubbedCapabilities(pluginId: string, harnesses: SkillHarness[]) {
  const integration = skillPluginEntries.find((entry) => entry.id === pluginId)?.skillIntegration
  const visible = Boolean(
    integration &&
    integration.support !== 'unsupported' &&
    harnesses.some((harness) => harness === integration.harnessId),
  )
  return {
    ok: true as const,
    support: integration?.support ?? ('unsupported' as const),
    harnessId: integration?.harnessId ?? '',
    skills: visible
      ? [
          {
            id: 'backlog',
            name: 'backlog',
            description: 'Work Backlog items.',
            invocation: resolveSkillInvocation(integration, 'backlog') ?? plainSkillInvocation('backlog'),
            source: 'builtin' as const,
            pluginIds: [pluginId],
          },
        ]
      : [],
    servers: [],
    diagnostics: [],
  }
}

function installSkillWindowApiStub(input: {
  sessions: TerminalSessionSnapshot[]
  /** Harness directories the skill is actually installed in. */
  harnesses?: SkillHarness[]
  capabilitiesResult?: { ok: false; message: string }
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
        pluginsList: async () => ({ ok: true as const, plugins: skillPluginEntries }),
        agentCapabilities: async ({ pluginId }: { pluginId: string }) =>
          input.capabilitiesResult ?? stubbedCapabilities(pluginId, input.harnesses ?? []),
      },
    },
  })
  return writes
}

// Each harness produces its own manifest's string, and nothing is submitted:
// the write is a bracketed paste ending in a space, never a carriage return.
async function testEachHarnessRendersItsOwnInvocation(): Promise<void> {
  const cases: Array<{ cli: string; harnesses: SkillHarness[]; text: string }> = [
    { cli: 'claude-code', harnesses: ['claude'], text: '/backlog ' },
    { cli: 'grok', harnesses: ['grok'], text: '/backlog ' },
    { cli: 'codex', harnesses: ['codex'], text: 'Use $backlog. ' },
    { cli: 'opencode', harnesses: ['opencode'], text: 'Use the backlog skill. ' },
    // No skill integration declared: the plain mention every agent can follow.
    { cli: 'cursor', harnesses: ['cursor'], text: 'Use the backlog skill. ' },
  ]

  for (const testCase of cases) {
    const writes = installSkillWindowApiStub({
      sessions: [agentSession({ cli: testCase.cli as never })],
      harnesses: testCase.harnesses,
    })
    const sent = await sendSkillToTerminal({
      skillId: 'backlog',
      sessionId: 'session-1',
      workspaceRoot: '/repo',
    })
    assert.deepEqual(sent, { ok: true, text: testCase.text }, `${testCase.cli}: manifest form`)
    assert.deepEqual(
      writes,
      [{ sessionId: 'session-1', data: bracketedPaste(testCase.text) }],
      `${testCase.cli}: one bracketed paste`,
    )
    assert.doesNotMatch(writes[0].data, /[\r\n]/, `${testCase.cli}: nothing is submitted`)
  }
}

// The pane is bound to one agent; the drop decides by the session it lands on.
async function testDropUsesTheTargetSessionsForm(): Promise<void> {
  installSkillWindowApiStub({
    sessions: [agentSession({ cli: 'codex' })],
    harnesses: ['claude', 'codex'],
  })
  const sent = await sendSkillToTerminal({
    skillId: 'backlog',
    sessionId: 'session-1',
    workspaceRoot: '/repo',
  })
  assert.deepEqual(sent, { ok: true, text: 'Use $backlog. ' })
}

// Present in another CLI's harness but not this one: the native form would name
// a skill this agent cannot see, so it falls back to the plain mention.
async function testSkillMissingFromTargetHarnessFallsBackToPlainMention(): Promise<void> {
  installSkillWindowApiStub({
    sessions: [agentSession({ cli: 'codex' })],
    harnesses: ['claude'],
  })
  const sent = await sendSkillToTerminal({
    skillId: 'backlog',
    sessionId: 'session-1',
    workspaceRoot: '/repo',
  })
  assert.deepEqual(sent, { ok: true, text: 'Use the backlog skill. ' })
}

async function testUnsupportedCliIsRefusedNotHandedASentence(): Promise<void> {
  const writes = installSkillWindowApiStub({
    sessions: [agentSession({ cli: 'generic-shell' })],
    harnesses: ['claude'],
  })
  const sent = await sendSkillToTerminal({
    skillId: 'backlog',
    sessionId: 'session-1',
    workspaceRoot: '/repo',
  })
  assert.deepEqual(sent, { ok: false, message: 'This agent does not read skills.' })
  assert.deepEqual(writes, [])
}

// A plain terminal is a shell: no agent to read the skill, and no CLI to decide
// the form. Refused at the core, so no caller can paste a sentence into one.
async function testPlainTerminalIsRefused(): Promise<void> {
  const writes = installSkillWindowApiStub({
    sessions: [session({ kind: 'terminal', sessionId: 'session-1' })],
    harnesses: ['claude'],
  })
  const sent = await sendSkillToTerminal({
    skillId: 'backlog',
    sessionId: 'session-1',
    workspaceRoot: '/repo',
  })
  assert.deepEqual(sent, { ok: false, message: 'Skills go to an agent, not a plain terminal.' })
  assert.deepEqual(writes, [])
}

async function testDeadSessionReportsRatherThanNoOps(): Promise<void> {
  const writes = installSkillWindowApiStub({
    sessions: [agentSession({ processAlive: false })],
    harnesses: ['claude'],
  })
  const sent = await sendSkillToTerminal({
    skillId: 'backlog',
    sessionId: 'session-1',
    workspaceRoot: '/repo',
  })
  assert.deepEqual(sent, { ok: false, message: 'Terminal session is no longer running.' })
  assert.deepEqual(writes, [])
}

// A read that failed leaves the FORM unknown; parking a guess would look like
// the skill simply did not work.
async function testUnreadableWorkspaceReportsRatherThanGuessing(): Promise<void> {
  const writes = installSkillWindowApiStub({
    sessions: [agentSession({ cli: 'claude-code' })],
    capabilitiesResult: { ok: false, message: 'Workspace root does not exist.' },
  })
  const sent = await sendSkillToTerminal({
    skillId: 'backlog',
    sessionId: 'session-1',
    workspaceRoot: '/gone',
  })
  assert.deepEqual(sent, { ok: false, message: 'Workspace root does not exist.' })
  assert.deepEqual(writes, [])
}

// --- the drop wrapper -------------------------------------------------------

function skillDataTransfer(value: unknown, mime = MULTICODE_SKILL_DROP_MIME): DataTransfer {
  const entries = new Map<string, string>([[mime, JSON.stringify(value)]])
  return {
    types: Array.from(entries.keys()),
    getData: (type: string) => entries.get(type) ?? '',
  } as unknown as DataTransfer
}

async function testSkillDropCarriesItsOwnMimeAndWorkspace(): Promise<void> {
  const writes = installSkillWindowApiStub({
    sessions: [agentSession({ cli: 'claude-code' })],
    harnesses: ['claude'],
  })

  // Its own MIME: a payload under the file-drop type is not a skill drop.
  assert.deepEqual(
    await pasteDroppedSkillIntoTerminal({
      dataTransfer: skillDataTransfer(
        { version: 1, skillId: 'backlog', workspaceId: 'workspace-1' },
        MULTICODE_FILE_DROP_MIME,
      ),
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      workspaceRoot: '/repo',
    }),
    { ok: false, message: 'No skill was dropped.' },
  )

  assert.deepEqual(
    await pasteDroppedSkillIntoTerminal({
      dataTransfer: skillDataTransfer({ version: 1, skillId: 'backlog', workspaceId: 'workspace-2' }),
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      workspaceRoot: '/repo',
    }),
    { ok: false, message: 'Drop skills into a terminal from the same workspace.' },
  )
  assert.deepEqual(writes, [], 'neither rejection reached the terminal')

  assert.deepEqual(
    await pasteDroppedSkillIntoTerminal({
      dataTransfer: skillDataTransfer({ version: 1, skillId: 'backlog', workspaceId: 'workspace-1' }),
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      workspaceRoot: '/repo',
    }),
    { ok: true, text: '/backlog ' },
  )
  assert.deepEqual(writes, [{ sessionId: 'session-1', data: bracketedPaste('/backlog ') }])
}

function testSkillDropDataRoundTrips(): void {
  const entries = new Map<string, string>()
  const dataTransfer = {
    types: [] as string[],
    effectAllowed: 'none',
    setData: (type: string, value: string) => {
      entries.set(type, value)
      ;(dataTransfer.types as string[]).push(type)
    },
    getData: (type: string) => entries.get(type) ?? '',
  }
  setSkillDropData(dataTransfer as unknown as DataTransfer, {
    version: 1,
    skillId: 'backlog',
    workspaceId: 'workspace-1',
  })
  assert.equal(dataTransfer.effectAllowed, 'copy')
  assert.equal(hasSkillDropData(dataTransfer as unknown as DataTransfer), true)
  assert.equal(
    entries.get(MULTICODE_SKILL_DROP_MIME),
    JSON.stringify({ version: 1, skillId: 'backlog', workspaceId: 'workspace-1' }),
  )
  // Dropped somewhere that is not a terminal, the id is the useful text.
  assert.equal(entries.get('text/plain'), 'backlog')
  // A drag with no skill on it is not a skill drop.
  assert.equal(hasSkillDropData({ types: [MULTICODE_FILE_DROP_MIME] } as unknown as DataTransfer), false)
}

void testSlashCapableAgentGetsBacklogCommand()
  .then(testNonSlashAgentGetsQuotedRelativePath)
  .then(testWorktreeSessionGetsPlainPathNeverBacklog)
  .then(testDeadSessionReturnsExplicitError)
  .then(testWorkspaceMismatchRejectsBeforeWrite)
  .then(() => {
    testBacklogItemDropDescriptorGate()
  })
  .then(testHandoffDescriptorRidesResult)
  .then(testEachHarnessRendersItsOwnInvocation)
  .then(testDropUsesTheTargetSessionsForm)
  .then(testSkillMissingFromTargetHarnessFallsBackToPlainMention)
  .then(testUnsupportedCliIsRefusedNotHandedASentence)
  .then(testPlainTerminalIsRefused)
  .then(testDeadSessionReportsRatherThanNoOps)
  .then(testUnreadableWorkspaceReportsRatherThanGuessing)
  .then(testSkillDropCarriesItsOwnMimeAndWorkspace)
  .then(() => {
    testSkillDropDataRoundTrips()
  })
  .then(() => {
    console.log('terminalDrop: ok')
  })
