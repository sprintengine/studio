import assert from 'node:assert/strict'

import {
  ensureSkillForAgent,
  renderSkillInvocation,
  renderSkillInvocationTemplate,
  skillInstalledForHarness,
  type SkillIntegrationLike,
} from './skillInvocation'

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
  ;(globalThis as { window?: unknown }).window = {
    api: {
      builtinSkillInstall: async (input: { skillId: string }) => {
        calls.push(`builtin:${input.skillId}`)
        return { ok: true, status: 'installed' }
      },
      skillPackInstall: async (input: { slug: string }) => {
        calls.push(`pack:${input.slug}`)
        return { ok: true, installed: {}, log: '' }
      },
    },
  }

  // Already-installed builtin: no install call.
  const installedBuiltin = await ensureSkillForAgent({
    workspaceRoot: '/ws',
    skill: { id: 'backlog', source: 'builtin', installState: 'installed' },
  })
  assert.deepEqual(installedBuiltin, { ok: true })
  assert.deepEqual(calls, [])

  // Missing builtin installs through the builtin manager.
  const missingBuiltin = await ensureSkillForAgent({
    workspaceRoot: '/ws',
    skill: { id: 'debug', source: 'builtin', installState: 'available' },
  })
  assert.deepEqual(missingBuiltin, { ok: true })
  assert.deepEqual(calls, ['builtin:debug'])

  // Available pack installs by slug; missing slug is a clean failure.
  const pack = await ensureSkillForAgent({
    workspaceRoot: '/ws',
    skill: { id: 'p', source: 'pack', installState: 'available', packSlug: 'org/pack' },
  })
  assert.deepEqual(pack, { ok: true })
  assert.deepEqual(calls, ['builtin:debug', 'pack:org/pack'])

  const noSlug = await ensureSkillForAgent({
    workspaceRoot: '/ws',
    skill: { id: 'p2', source: 'pack', installState: 'available' },
  })
  assert.equal(noSlug.ok, false)

  // Custom skills are presence-only.
  const custom = await ensureSkillForAgent({
    workspaceRoot: '/ws',
    skill: { id: 'c', source: 'custom', installState: 'installed' },
  })
  assert.deepEqual(custom, { ok: true })
  assert.deepEqual(calls, ['builtin:debug', 'pack:org/pack'])

  console.log('skillInvocation tests passed')
}

main()
