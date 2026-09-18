import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  plainSkillInvocation,
  renderSkillMention,
  renderSkillInvocationTemplate,
  resolveSkillInvocation,
  resolveSkillMentionPrefix,
} from './skill-invocation'

// MC-2147. A skill is named in the prompt, not attached as a flag, so a surface
// needs to know which character (if any) this CLI's users type to name one. The
// answer is DECLARED per plugin (`invocation.mentionPrefix`) and never inferred
// from `explicitTemplate` — these tests pin both the resolver contract and the
// values the shipped manifests actually carry.

function integration(invocation: Record<string, unknown>, support = 'native') {
  return { support, invocation } as Parameters<typeof resolveSkillMentionPrefix>[0]
}

// 1. The prefix is read, not derived.
{
  assert.equal(resolveSkillMentionPrefix(integration({ mentionPrefix: '/' })), '/')
  assert.equal(resolveSkillMentionPrefix(integration({ mentionPrefix: '$' })), '$')
  assert.equal(
    resolveSkillMentionPrefix(integration({ explicitTemplate: 'Use the {{skillId}} skill.' })),
    undefined,
    'a CLI with a sentence form and no declared prefix has no trigger — never "e"',
  )
  assert.equal(resolveSkillMentionPrefix(undefined), undefined, 'no integration, no trigger')
  assert.equal(
    resolveSkillMentionPrefix(integration({ mentionPrefix: '/' }, 'prompt-shim')),
    undefined,
    'a non-native integration cannot carry a native mention',
  )
  assert.equal(
    resolveSkillMentionPrefix(integration({ mentionPrefix: '   ' })),
    undefined,
    'whitespace is not a trigger',
  )
}

// 2. The mention is the prefix form, not the standalone sentence. Inserting
//    `explicitTemplate` mid-prompt would write the user's sentence for them.
{
  assert.equal(
    renderSkillMention(integration({ mentionPrefix: '/', explicitTemplate: '/{{skillId}}' }), 'design-review'),
    '/design-review',
  )
  assert.equal(
    renderSkillMention(integration({ mentionPrefix: '$', explicitTemplate: 'Use ${{skillId}}.' }), 'design-review'),
    '$design-review',
    'codex inserts the mention, not "Use $design-review."',
  )
  assert.equal(
    renderSkillMention(integration({ explicitTemplate: 'Use the {{skillId}} skill.' }), 'design-review'),
    undefined,
    'no prefix, nothing to insert — the caller keeps a picker',
  )
  assert.equal(
    renderSkillMention(integration({ mentionPrefix: '#', mentionTemplate: '{{mentionPrefix}}{{skillId}}!' }), 'audit'),
    '#audit!',
    'an explicit mentionTemplate wins over the default',
  )
}

// 3. The standalone form is untouched by any of this — it has other callers
//    (debug launch, connector chat, backlog handoff).
{
  assert.equal(resolveSkillInvocation(integration({ explicitTemplate: 'Use ${{skillId}}.' }), 'debug'), 'Use $debug.')
  assert.equal(
    renderSkillInvocationTemplate('/{{skillId}} {{path}}', { skillId: 'a', skillName: 'A', path: 'p' }),
    '/a p',
  )
  assert.equal(plainSkillInvocation('debug'), 'Use the debug skill.')
}

// 4. The shipped manifests: every CLI whose skills are real slash commands
//    declares `/`, codex declares `$`, and opencode deliberately declares none.
{
  const read = (id: string) =>
    JSON.parse(readFileSync(join(process.cwd(), 'resources/plugins', id, 'plugin.json'), 'utf8')) as {
      skillIntegration?: { support: string; invocation?: Record<string, unknown> }
    }

  for (const id of ['claude-code', 'kimi-claude', 'zai', 'grok']) {
    const manifest = read(id)
    assert.equal(
      resolveSkillMentionPrefix(manifest.skillIntegration as never),
      '/',
      `${id} runs a CLI with real slash commands, so it declares "/"`,
    )
  }

  assert.equal(resolveSkillMentionPrefix(read('codex').skillIntegration as never), '$', 'codex mentions are $-prefixed')
  assert.equal(
    resolveSkillMentionPrefix(read('opencode').skillIntegration as never),
    undefined,
    'opencode names skills in a sentence — no trigger, and the surface must keep its picker',
  )

  // Any plugin that declares nativeSlashCommand MUST carry the trigger, or a
  // type-ahead silently stops working for that CLI.
  for (const id of ['claude-code', 'kimi-claude', 'zai', 'grok', 'codex', 'opencode']) {
    const invocation = read(id).skillIntegration?.invocation ?? {}
    if (invocation.nativeSlashCommand !== true) continue
    assert.equal(invocation.mentionPrefix, '/', `${id} declares nativeSlashCommand and must declare its prefix`)
  }
}

console.log('skill-invocation.test.ts: ok')
