import { BACKLOG_SKILL_ID, backlogLifecycleHandoffPrompt } from '../../../shared/backlog/handoff-prompt'
import { renderSkillInvocationTemplate } from '../../../shared/skill-invocation'
import { hasAgentLink } from './agentBacklogLinks'
import { hasSprintEngineRunLink } from './sprintengineBacklogLinks'
import type { SkillIntegrationLike } from './skillInvocation'
import type { BacklogItem } from './backlog'

export { BACKLOG_SKILL_ID }

// Handing a Backlog item to a NEW agent, from the item's own detail pane. The
// drag-drop path (terminalDrop) hands an item to an agent that is ALREADY
// running and pastes the invocation at its prompt; this one picks the model
// first and the invocation is the agent's startup prompt, exactly as the
// automation `backlog.work` tool composes it.

/**
 * Whether an item can be handed to a fresh agent. A finished record must not be
 * re-handed (the same gate `backlog.work` applies), and an item that already
 * has an owner — an agent working it, or a Sprint delivering it — is withheld
 * so a second launch cannot fork the effort behind the first one's back. Those
 * items show "Open agent" / "Open Sprint" instead.
 */
export function canHandBacklogItemToAgent(item: BacklogItem): boolean {
  return (
    item.status !== 'archived'
    && item.status !== 'completed'
    && !hasAgentLink(item)
    && !hasSprintEngineRunLink(item)
  )
}

/**
 * The startup prompt for the handoff: the picked CLI's own Backlog-skill
 * invocation (`/backlog backlog/foo.md` on Claude, `Use $backlog to work …` on
 * Codex) where the plugin declares a file-drop template, and the CLI-agnostic
 * lifecycle block everywhere else — an unknown CLI, one that declares no skill
 * integration, and one whose skills are unsupported.
 *
 * A path carrying a single quote falls back too: the template's argument is
 * single-quoted when it contains whitespace, and there is no escaping form that
 * every CLI's parser agrees on. The fallback names the path in prose, so the
 * handoff still lands.
 */
export function backlogHandoffPrompt(input: {
  relativePath: string
  integration: SkillIntegrationLike | undefined
}): string {
  const { relativePath, integration } = input
  const template = integration && integration.support !== 'unsupported'
    ? integration.invocation?.fileDropTemplate
    : undefined
  if (!template || relativePath.includes("'")) return backlogLifecycleHandoffPrompt(relativePath)
  return renderSkillInvocationTemplate(template, {
    skillId: BACKLOG_SKILL_ID,
    skillName: 'Backlog',
    path: /\s/.test(relativePath) ? `'${relativePath}'` : relativePath,
  })
}
