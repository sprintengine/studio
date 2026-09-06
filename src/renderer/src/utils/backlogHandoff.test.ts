import assert from 'node:assert/strict'

import type { BacklogItem } from './backlog'
import { buildAgentBacklogLink } from './agentBacklogLinks'
import { backlogHandoffPrompt, canHandBacklogItemToAgent, BACKLOG_SKILL_ID } from './backlogHandoff'
import type { SkillIntegrationLike } from './skillInvocation'

const baseItem: BacklogItem = {
  id: 'backlog/item.md',
  objectId: 'backlog_item',
  path: '/repo/backlog/item.md',
  relativePath: 'backlog/item.md',
  title: 'Item',
  kind: 'unknown',
  status: 'captured',
  isEpic: false,
  metadata: {},
  links: [],
  excerpt: '',
  modifiedAt: 1,
  createdAtMs: 1,
  size: 1,
  sourceContent: '# Item',
}

const claude: SkillIntegrationLike = {
  support: 'native',
  harnessId: 'claude',
  invocation: { fileDropTemplate: '/{{skillId}} {{path}}', nativeSlashCommand: true },
}

const codex: SkillIntegrationLike = {
  support: 'native',
  harnessId: 'codex',
  invocation: { fileDropTemplate: 'Use ${{skillId}} to work {{path}}.', explicitMention: true },
}

function testWorkableItemsAreTheOnesOfferedToAnAgent(): void {
  assert.equal(canHandBacklogItemToAgent(baseItem), true)
  assert.equal(canHandBacklogItemToAgent({ ...baseItem, status: 'in_progress' }), true)

  // A finished record must never be re-handed — the same gate `backlog.work`
  // applies on the automation surface.
  assert.equal(canHandBacklogItemToAgent({ ...baseItem, status: 'completed' }), false)
  assert.equal(canHandBacklogItemToAgent({ ...baseItem, status: 'archived' }), false)

  // An item that already has an owner is withheld, so a second launch cannot
  // fork the effort behind the first one's back. Those items show "Open agent"
  // (or "Open Sprint") instead.
  assert.equal(
    canHandBacklogItemToAgent({
      ...baseItem,
      links: [buildAgentBacklogLink({ workspaceId: 'ws-1', agentId: 'agent-7', agentName: 'Fred Walsh' })],
    }),
    false,
  )
  assert.equal(
    canHandBacklogItemToAgent({
      ...baseItem,
      links: [
        {
          id: 'run',
          moduleId: 'sprint-engine',
          type: 'execution',
          label: 'Sprint',
          target: { kind: 'sprintengine.run', id: 'run-1' },
        },
      ],
    }),
    false,
  )
}

function testThePromptIsThePickedCliOwnBacklogInvocation(): void {
  assert.equal(
    backlogHandoffPrompt({ relativePath: 'backlog/item.md', integration: claude }),
    '/backlog backlog/item.md',
  )
  assert.equal(
    backlogHandoffPrompt({ relativePath: 'backlog/item.md', integration: codex }),
    'Use $backlog to work backlog/item.md.',
  )
  // The template's argument is quoted when the path carries whitespace, exactly
  // as the drag-drop handoff quotes it.
  assert.equal(
    backlogHandoffPrompt({ relativePath: 'backlog/my item.md', integration: claude }),
    "/backlog 'backlog/my item.md'",
  )
}

function testAnUnresolvableInvocationFallsBackToTheLifecycleBlock(): void {
  const cases: Array<SkillIntegrationLike | undefined> = [
    // No CLI resolved at all (an unknown plugin id).
    undefined,
    // Declares no invocation template.
    { support: 'native', harnessId: 'claude' },
    // Declares that it reads no skills.
    { support: 'unsupported', harnessId: 'claude', invocation: { fileDropTemplate: '/{{skillId}} {{path}}' } },
  ]
  for (const integration of cases) {
    const prompt = backlogHandoffPrompt({ relativePath: 'backlog/item.md', integration })
    assert.match(prompt, /^Work the Backlog item at backlog\/item\.md\./)
    assert.match(prompt, /backlog\.update/, 'the fallback restates the lifecycle contract the skill would carry')
  }

  // A single quote in the path has no escaping form every CLI's parser agrees
  // on, so the handoff names the path in prose rather than shipping a broken
  // argument.
  assert.match(
    backlogHandoffPrompt({ relativePath: "backlog/o'brien.md", integration: claude }),
    /^Work the Backlog item at backlog\/o'brien\.md\./,
  )
}

function main(): void {
  assert.equal(BACKLOG_SKILL_ID, 'backlog')
  testWorkableItemsAreTheOnesOfferedToAnAgent()
  testThePromptIsThePickedCliOwnBacklogInvocation()
  testAnUnresolvableInvocationFallsBackToTheLifecycleBlock()
  console.log('backlogHandoff.test.ts passed')
}

main()
