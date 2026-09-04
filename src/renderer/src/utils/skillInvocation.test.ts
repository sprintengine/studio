import assert from 'node:assert/strict'

import {
  ensureSkillForAgent,
  renderSkillInvocation,
  renderSkillInvocationTemplate,
  skillInstalledForHarness,
  skillsSpawnAgentPatch,
  type SkillIntegrationLike,
} from './skillInvocation'
import type { WorkspaceSkill } from '../../../shared/electron-api'

const CLAUDE_INTEGRATION: SkillIntegrationLike = {
  support: 'native',
  harnessId: 'claude',
  invocation: {
    fileDropTemplate: '/{{skillId}} {{path}}',
    explicitTemplate: '/{{skillId}}',
    nativeSlashCommand: true,
  },
}

const CODEX_INTEGRATION: SkillIntegrationLike = {
  support: 'native',
  harnessId: 'codex',
  invocation: {
    fileDropTemplate: 'Use ${{skillId}} to work {{path}}.',
    explicitTemplate: 'Use ${{skillId}}.',
    explicitMention: true,
  },
}

const PROMPT_SHIM_INTEGRATION: SkillIntegrationLike = {
  support: 'prompt-shim',
  harnessId: 'shim-cli',
}

function main(): void {
  // Template rendering (shared with the file-drop path).
  assert.equal(
    renderSkillInvocationTemplate('/{{skillId}} {{path}}', {
      skillId: 'backlog',
      skillName: 'Backlog',
      path: 'backlog/item.md',
    }),
    '/backlog backlog/item.md',
  )
  assert.equal(
    renderSkillInvocationTemplate('Use {{skillName}} ({{skillId}}).', {
      skillId: 'debug',
      skillName: 'Debug',
    }),
    'Use Debug (debug).',
  )

  const skill = { id: 'backlog', name: 'Backlog' }

  // Native slash for claude, explicit mention for codex.
  assert.equal(
    renderSkillInvocation({ skill, integration: CLAUDE_INTEGRATION }),
    '/backlog',
  )
  assert.equal(
    renderSkillInvocation({ skill, integration: CODEX_INTEGRATION }),
    'Use $backlog.',
  )

  // Prompt-shim CLI, no integration, or a skill missing from the CLI's native
  // harness dir all fall back to the plain mention.
  assert.equal(
    renderSkillInvocation({ skill, integration: PROMPT_SHIM_INTEGRATION }),
    'Use the backlog skill.',
  )
  assert.equal(renderSkillInvocation({ skill }), 'Use the backlog skill.')
  assert.equal(
    renderSkillInvocation({ skill, integration: CLAUDE_INTEGRATION, nativeInstalled: false }),
    'Use the backlog skill.',
  )

  // Harness presence gating.
  assert.equal(
    skillInstalledForHarness(
      { harnesses: ['agents', 'claude'], installState: 'installed' },
      CLAUDE_INTEGRATION,
    ),
    true,
  )
  assert.equal(
    skillInstalledForHarness(
      { harnesses: ['agents'], installState: 'installed' },
      CLAUDE_INTEGRATION,
    ),
    false,
  )
  assert.equal(
    skillInstalledForHarness(
      { harnesses: [], installState: 'available' },
      CLAUDE_INTEGRATION,
    ),
    false,
  )

  void ensureSkillTests()
}

async function ensureSkillTests(): Promise<void> {
  const calls: string[] = []
  let reply: unknown = { ok: true, skillId: 'x', targets: [{ path: '.claude/skills/x', status: 'written' }] }
  ;(globalThis as { window?: unknown }).window = {
    api: {
      agentSkillAttach: async (input: { skillId: string }) => {
        calls.push(`attach:${input.skillId}`)
        return reply
      },
    },
  }

  // One path for every skill, whatever it came from: the renderer asks main to
  // put it where the agents read, and does not decide where that is.
  const builtin = await ensureSkillForAgent({ workspaceRoot: '/ws', skill: { id: 'debug' } })
  assert.deepEqual(builtin, { ok: true })
  const custom = await ensureSkillForAgent({ workspaceRoot: '/ws', skill: { id: 'c' } })
  assert.deepEqual(custom, { ok: true })
  assert.deepEqual(calls, ['attach:debug', 'attach:c'])

  // One harness refusing the write does not block an invocation the others can
  // serve; every harness failing does.
  reply = {
    ok: true,
    skillId: 'debug',
    targets: [
      { path: '.claude/skills/debug', status: 'written' },
      { path: '.grok/skills/debug', status: 'failed', message: 'EACCES' },
    ],
  }
  assert.deepEqual(await ensureSkillForAgent({ workspaceRoot: '/ws', skill: { id: 'debug' } }), { ok: true })

  reply = {
    ok: true,
    skillId: 'debug',
    targets: [{ path: '.claude/skills/debug', status: 'failed', message: 'EACCES: permission denied' }],
  }
  assert.deepEqual(await ensureSkillForAgent({ workspaceRoot: '/ws', skill: { id: 'debug' } }), {
    ok: false,
    message: 'EACCES: permission denied',
  })

  // A request main could not attempt keeps its own message.
  reply = { ok: false, message: 'No agent CLI on this machine reads workspace skills.' }
  assert.deepEqual(await ensureSkillForAgent({ workspaceRoot: '/ws', skill: { id: 'debug' } }), {
    ok: false,
    message: 'No agent CLI on this machine reads workspace skills.',
  })

  // The Skills & MCPs picks (browser-pane child 7): one skill keeps the
  // CLI-native form, several become plain mentions in pick order, and the
  // first builtin rides spawnSkillId.
  const backlog: WorkspaceSkill = { id: 'backlog', name: 'backlog', source: 'builtin', harnesses: ['claude'], installState: 'installed' }
  const review: WorkspaceSkill = { id: 'review-guide', name: 'review-guide', source: 'custom', harnesses: ['claude'], installState: 'installed' }
  assert.deepEqual(skillsSpawnAgentPatch([], CLAUDE_INTEGRATION), {})
  assert.deepEqual(skillsSpawnAgentPatch([backlog], CLAUDE_INTEGRATION), { spawnSkillId: 'backlog', cliPendingInput: '/backlog ' })
  assert.deepEqual(skillsSpawnAgentPatch([review, backlog], CLAUDE_INTEGRATION), {
    spawnSkillId: 'backlog',
    cliPendingInput: 'Use the review-guide skill. Use the backlog skill. ',
  })
  assert.deepEqual(skillsSpawnAgentPatch([review], CLAUDE_INTEGRATION), { cliPendingInput: '/review-guide ' })

  console.log('skillInvocation tests passed')
}

main()
