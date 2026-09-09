import assert from 'node:assert/strict'

import type {
  AgentSkillTarget,
  AgentSkillWriteResult,
  TerminalSessionSnapshot,
  WorkspaceSkill,
} from '../../../shared/electron-api'
import type { SkillIntegrationLike } from './skillInvocation'
import {
  AGENT_NO_LONGER_RUNNING_MESSAGE,
  describeHarnessWrites,
  listLiveAgentSessions,
  NO_WORKSPACE_FOLDER_MESSAGE,
  pickTargetSession,
  resolveWorkspaceSkill,
  selectLiveAgentSessions,
  skillRestartToast,
  useSkillInAgent,
  type SkillCliEntry,
} from './useSkillInAgent'

const CLAUDE_INTEGRATION: SkillIntegrationLike = {
  support: 'native',
  harnessId: 'claude',
  invocation: { explicitTemplate: '/{{skillId}}', nativeSlashCommand: true },
}

const CODEX_INTEGRATION: SkillIntegrationLike = {
  support: 'native',
  harnessId: 'codex',
  invocation: { explicitTemplate: 'Use ${{skillId}}.', explicitMention: true },
}

const CLIS: SkillCliEntry[] = [
  { id: 'claude-code', displayName: 'Claude Code', skillIntegration: CLAUDE_INTEGRATION },
  { id: 'codex', displayName: 'Codex', skillIntegration: CODEX_INTEGRATION },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    skillIntegration: { support: 'native', harnessId: 'opencode' },
  },
]

const SKILL: WorkspaceSkill = {
  id: 'backlog',
  name: 'Backlog',
  source: 'plugin',
  harnesses: [],
  installState: 'installed',
}

function session(input: Partial<TerminalSessionSnapshot>): TerminalSessionSnapshot {
  return {
    sessionId: 'session-1',
    processAlive: true,
    kind: 'agent',
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
  } as TerminalSessionSnapshot
}

function target(input: Partial<AgentSkillTarget>): AgentSkillTarget {
  return {
    harnessId: 'claude',
    pluginIds: ['claude-code'],
    path: '.claude/skills/backlog',
    restartRequired: false,
    status: 'written',
    ...input,
  }
}

function bracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`
}

type WriteCall = { sessionId: string; data: string }

// The sessions the flow tests paste into, all live: the flow asks the list
// again right before the write, so a target that is absent from it is refused.
const LIVE_TARGETS = [
  session({ sessionId: 'alive', cli: 'claude-code', workspaceId: 'w1' }),
  session({ sessionId: 's', cli: 'claude-code', workspaceId: 'w1' }),
]

function installWindowApiStub(input: {
  sessions?: TerminalSessionSnapshot[]
  attach?: AgentSkillWriteResult
  skills?: WorkspaceSkill[]
  skillsResult?: { ok: false; message: string }
  terminalWriteThrows?: string
  terminalListThrows?: string
}): { writes: WriteCall[]; attachCalls: unknown[] } {
  const writes: WriteCall[] = []
  const attachCalls: unknown[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        terminalList: async () => {
          if (input.terminalListThrows) throw new Error(input.terminalListThrows)
          return input.sessions ?? LIVE_TARGETS
        },
        terminalWrite: async (sessionId: string, data: string) => {
          if (input.terminalWriteThrows) throw new Error(input.terminalWriteThrows)
          writes.push({ sessionId, data })
        },
        agentSkillAttach: async (attachInput: unknown) => {
          attachCalls.push(attachInput)
          return (
            input.attach ?? { ok: true as const, skillId: 'backlog', targets: [target({})] }
          )
        },
        workspaceSkillsList: async () =>
          input.skillsResult ?? { ok: true as const, skills: input.skills ?? [SKILL] },
        builtinSkillStatus: async () => ({ ok: false as const, message: 'not a builtin' }),
      },
    },
  })
  return { writes, attachCalls }
}

async function main(): Promise<void> {
  // ── Which sessions can take a skill ──────────────────────────────────────
  const sessions = [
    session({ sessionId: 'alive', cli: 'claude-code', workspaceId: 'w1' }),
    session({ sessionId: 'plain-terminal', kind: 'terminal', workspaceId: 'w1' }),
    session({ sessionId: 'dead', processAlive: false, workspaceId: 'w1' }),
    session({ sessionId: 'worktree-mode', executionMode: 'worktree', workspaceId: 'w1' }),
    session({ sessionId: 'worktree-path', worktreePath: '/repo/.worktrees/a', workspaceId: 'w1' }),
    session({ sessionId: 'other-workspace', workspaceId: 'w2' }),
  ]
  assert.deepEqual(
    selectLiveAgentSessions(sessions).map((live) => live.sessionId),
    ['alive', 'other-workspace'],
    'only live, non-worktree agent ptys',
  )
  assert.deepEqual(
    selectLiveAgentSessions(sessions, { workspaceId: 'w1' }).map((live) => live.sessionId),
    ['alive'],
    'scoped to one workspace when asked',
  )
  // No scope keeps every window's agents — what the Installed inventory shows.
  installWindowApiStub({ sessions })
  assert.equal((await listLiveAgentSessions()).length, 2)
  assert.equal((await listLiveAgentSessions({ workspaceId: 'w2' })).length, 1)

  // A menu row's name: the agent's display name, then its id, then the session.
  assert.equal(
    selectLiveAgentSessions([
      session({ sessionId: 's', agentId: 'a1', agentSession: { displayName: 'Reviewer' } as never }),
    ])[0].label,
    'Reviewer',
  )
  assert.equal(selectLiveAgentSessions([session({ sessionId: 's', agentId: 'a1' })])[0].label, 'a1')
  assert.equal(selectLiveAgentSessions([session({ sessionId: 's' })])[0].label, 's')

  // ── Picking one without asking ───────────────────────────────────────────
  const live = selectLiveAgentSessions(sessions)
  assert.equal(pickTargetSession(live)?.sessionId, undefined, 'two agents is a question, not an answer')
  assert.equal(pickTargetSession([live[0]])?.sessionId, 'alive', 'one agent needs no menu')
  assert.equal(
    pickTargetSession(live, { sessionId: 'other-workspace' })?.sessionId,
    'other-workspace',
    'the pane in front of the user wins',
  )
  assert.equal(
    pickTargetSession(live, { sessionId: 'gone' })?.sessionId,
    undefined,
    'a preference that is no longer live does not fall through to a guess',
  )
  assert.equal(
    pickTargetSession(
      selectLiveAgentSessions([
        session({ sessionId: 's1', agentId: 'a1' }),
        session({ sessionId: 's2', agentId: 'a2' }),
      ]),
      { agentId: 'a2' },
    )?.sessionId,
    's2',
    'the focused agent resolves to its session',
  )

  // ── The happy path ───────────────────────────────────────────────────────
  {
    const stub = installWindowApiStub({})
    const result = await useSkillInAgent({
      workspaceRoot: '/repo',
      skill: SKILL,
      session: { sessionId: 'alive', cli: 'claude-code' },
      clis: CLIS,
    })
    assert.equal(result.ok, true)
    assert.deepEqual(stub.attachCalls, [{ workspaceRoot: '/repo', skillId: 'backlog' }])
    assert.deepEqual(
      stub.writes,
      [{ sessionId: 'alive', data: bracketedPaste('/backlog ') }],
      'bracketed paste, trailing space, nothing submitted',
    )
    assert.equal(result.ok && result.invocation, '/backlog')
    assert.equal(result.ok && result.restartRequired, false)
  }

  // ── Per-harness invocation text ──────────────────────────────────────────
  {
    const stub = installWindowApiStub({
      attach: { ok: true, skillId: 'backlog', targets: [target({ harnessId: 'codex', pluginIds: ['codex'] })] },
    })
    await useSkillInAgent({
      workspaceRoot: '/repo',
      skill: SKILL,
      session: { sessionId: 's', cli: 'codex' },
      clis: CLIS,
    })
    assert.deepEqual(stub.writes, [{ sessionId: 's', data: bracketedPaste('Use $backlog. ') }])
  }
  {
    // A CLI whose manifest declares no invocation template, and a CLI this app
    // does not know at all, both get the plain mention every agent can follow.
    const stub = installWindowApiStub({
      attach: { ok: true, skillId: 'backlog', targets: [target({ harnessId: 'opencode', pluginIds: ['opencode'] })] },
    })
    await useSkillInAgent({
      workspaceRoot: '/repo',
      skill: SKILL,
      session: { sessionId: 's', cli: 'opencode' },
      clis: CLIS,
    })
    await useSkillInAgent({
      workspaceRoot: '/repo',
      skill: SKILL,
      session: { sessionId: 's', cli: 'nobody-knows' },
      clis: CLIS,
    })
    assert.deepEqual(
      stub.writes.map((write) => write.data),
      [bracketedPaste('Use the backlog skill. '), bracketedPaste('Use the backlog skill. ')],
    )
  }
  {
    // The harness dir the attach just wrote counts as installed: the skill
    // record was read BEFORE the attach, so its own harness list is stale and
    // would have demoted a freshly-installed skill to the plain mention.
    const stub = installWindowApiStub({
      attach: {
        ok: true,
        skillId: 'backlog',
        targets: [target({ harnessId: 'claude', status: 'written' })],
      },
    })
    await useSkillInAgent({
      workspaceRoot: '/repo',
      skill: { ...SKILL, harnesses: [], installState: 'available' },
      session: { sessionId: 's', cli: 'claude-code' },
      clis: CLIS,
    })
    assert.deepEqual(stub.writes, [{ sessionId: 's', data: bracketedPaste('/backlog ') }])
  }
  {
    // A harness the attach could NOT write is not a native install.
    const stub = installWindowApiStub({
      attach: {
        ok: true,
        skillId: 'backlog',
        targets: [
          target({ harnessId: 'claude', status: 'failed', message: 'EACCES' }),
          target({ harnessId: 'codex', pluginIds: ['codex'], status: 'written' }),
        ],
      },
    })
    await useSkillInAgent({
      workspaceRoot: '/repo',
      skill: { ...SKILL, harnesses: [], installState: 'available' },
      session: { sessionId: 's', cli: 'claude-code' },
      clis: CLIS,
    })
    assert.deepEqual(
      stub.writes,
      [{ sessionId: 's', data: bracketedPaste('Use the backlog skill. ') }],
      'partial success still invokes — in the form the CLI can actually follow',
    )
  }

  // ── restartRequired rides back, and is sayable ───────────────────────────
  {
    installWindowApiStub({
      attach: {
        ok: true,
        skillId: 'backlog',
        targets: [
          target({ harnessId: 'claude', pluginIds: ['claude-code', 'zai'], restartRequired: false }),
          target({ harnessId: 'opencode', pluginIds: ['opencode'], restartRequired: true }),
        ],
      },
    })
    const result = await useSkillInAgent({
      workspaceRoot: '/repo',
      skill: SKILL,
      session: { sessionId: 's', cli: 'claude-code' },
      clis: CLIS,
    })
    assert.equal(result.ok && result.restartRequired, true)
    assert.deepEqual(
      result.ok ? result.harnesses.map((harness) => harness.harnessId) : [],
      ['claude', 'opencode'],
    )
    const toast = skillRestartToast(result, 'Backlog')
    assert.equal(toast?.tone, 'warn')
    assert.equal(toast?.title, 'Installed for OpenCode', 'only the CLIs that need it are named')
    assert.match(String(toast?.description), /may need a restart to see new skills/)
  }
  {
    // Nothing to say when every CLI re-reads its skills directory live —
    // measured true for Claude Code and Codex.
    installWindowApiStub({})
    const result = await useSkillInAgent({
      workspaceRoot: '/repo',
      skill: SKILL,
      session: { sessionId: 's', cli: 'claude-code' },
      clis: CLIS,
    })
    assert.equal(skillRestartToast(result, 'Backlog'), null)
  }
  // `unchanged` is a CLI that already had the skill: nothing new to notice, so
  // no restart to mention and nothing to report as written.
  assert.deepEqual(
    describeHarnessWrites([target({ status: 'unchanged', restartRequired: true })]),
    [],
  )
  assert.deepEqual(
    describeHarnessWrites([target({ pluginIds: ['claude-code', 'unknown-cli'] })], CLIS)[0].labels,
    ['Claude Code', 'unknown-cli'],
  )

  // ── Refusals say why ─────────────────────────────────────────────────────
  {
    installWindowApiStub({})
    const noFolder = await useSkillInAgent({
      workspaceRoot: null,
      skill: SKILL,
      session: { sessionId: 's', cli: 'claude-code' },
    })
    assert.deepEqual(noFolder, { ok: false, message: NO_WORKSPACE_FOLDER_MESSAGE })
    assert.deepEqual(await resolveWorkspaceSkill({ workspaceRoot: null, skillId: 'backlog' }), {
      ok: false,
      message: NO_WORKSPACE_FOLDER_MESSAGE,
    })
  }
  {
    const stub = installWindowApiStub({
      attach: { ok: false, message: 'No installed CLI reads skills.' },
    })
    const refused = await useSkillInAgent({
      workspaceRoot: '/repo',
      skill: SKILL,
      session: { sessionId: 's', cli: 'claude-code' },
    })
    assert.deepEqual(refused, { ok: false, message: 'No installed CLI reads skills.' })
    assert.deepEqual(stub.writes, [], 'nothing is pasted for a skill that was never installed')
  }
  {
    installWindowApiStub({ terminalWriteThrows: 'session is gone' })
    const refused = await useSkillInAgent({
      workspaceRoot: '/repo',
      skill: SKILL,
      session: { sessionId: 's', cli: 'claude-code' },
    })
    assert.equal(refused.ok, false)
    assert.equal(!refused.ok && refused.message, 'session is gone')
  }
  {
    // The agent died between the menu listing it and the paste. Main's write
    // handler drops input to an exited session without a word, so the flow
    // asks the list again first — and the install still happened, because the
    // skill is wanted in the workspace whichever agent ends up using it.
    const gone = installWindowApiStub({ sessions: [] })
    const refused = await useSkillInAgent({
      workspaceRoot: '/repo',
      skill: SKILL,
      session: { sessionId: 's', cli: 'claude-code' },
      clis: CLIS,
    })
    assert.deepEqual(refused, { ok: false, message: AGENT_NO_LONGER_RUNNING_MESSAGE })
    assert.deepEqual(gone.writes, [], 'nothing is written to a session that is no longer there')
    assert.equal(gone.attachCalls.length, 1)

    // Still listed, but exited (or paused, or moved into a worktree): the same
    // rule that admitted it to the menu refuses it here.
    const dead = installWindowApiStub({
      sessions: [session({ sessionId: 's', cli: 'claude-code', processAlive: false })],
    })
    const refusedDead = await useSkillInAgent({
      workspaceRoot: '/repo',
      skill: SKILL,
      session: { sessionId: 's', cli: 'claude-code' },
      clis: CLIS,
    })
    assert.equal(refusedDead.ok, false)
    assert.deepEqual(dead.writes, [])

    // A list that cannot be read is not evidence the agent is gone: the write
    // goes ahead, as it always did, and its own outcome is the answer.
    const unknown = installWindowApiStub({ terminalListThrows: 'ipc down' })
    const wrote = await useSkillInAgent({
      workspaceRoot: '/repo',
      skill: SKILL,
      session: { sessionId: 's', cli: 'claude-code' },
      clis: CLIS,
    })
    assert.equal(wrote.ok, true)
    assert.equal(unknown.writes.length, 1)
  }

  // ── Resolving the record a row only names ────────────────────────────────
  {
    installWindowApiStub({ skills: [SKILL] })
    const found = await resolveWorkspaceSkill({ workspaceRoot: '/repo', skillId: 'backlog' })
    assert.equal(found.ok && found.skill.name, 'Backlog')
    const missing = await resolveWorkspaceSkill({ workspaceRoot: '/repo', skillId: 'nope' })
    assert.equal(missing.ok, false)
  }
  {
    installWindowApiStub({ skillsResult: { ok: false, message: 'the inventory could not be read' } })
    const failed = await resolveWorkspaceSkill({ workspaceRoot: '/repo', skillId: 'backlog' })
    assert.deepEqual(failed, { ok: false, message: 'the inventory could not be read' })
  }

  console.log('useSkillInAgent.test.ts ok')
}

void main()
