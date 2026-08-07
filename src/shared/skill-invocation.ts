import type { PluginSkillInvocation, PluginSkillSupport } from './plugin-manifest'

// Renders a plugin's declared skill-invocation template. Shared by the terminal
// file-drop path ({{path}} templates), the skill picker (explicit templates
// without a path), and the automation backlog.work handoff (main-process). Kept
// node-free so main and renderer resolve invocations through one contract.
export function renderSkillInvocationTemplate(
  template: string,
  values: { skillId: string; skillName: string; path?: string },
): string {
  return template
    .replace(/\{\{\s*skillId\s*\}\}/g, values.skillId)
    .replace(/\{\{\s*skillName\s*\}\}/g, values.skillName)
    .replace(/\{\{\s*path\s*\}\}/g, values.path ?? '')
}

/**
 * The plain-prompt invocation, for a CLI with no native explicit form. Every
 * agent can follow it, so it is the fallback wherever a native template is
 * absent — one wording, shared by the resolver and the renderer.
 */
export function plainSkillInvocation(skillId: string): string {
  return `Use the ${skillId} skill.`
}

/**
 * The CLI-native explicit invocation for a skill (e.g. `/debug` / `/use-railway`
 * for Claude, `Use $debug.` / `Use $use-railway.` for Codex), read from a
 * plugin's declared skill-invocation template with `{{skillId}}` substituted.
 * Undefined when the plugin declares no native skill support or no explicit
 * template, so callers fall back to the plain directive/instruction.
 *
 * Node-free and shared so the main-process debug launch (resolveDebugSkillInvocation)
 * and the renderer connector-chat seed resolve invocations through one contract.
 * The parameter is the `{ support, invocation }` shape common to both
 * PluginSkillIntegration (main manifest) and PluginSkillCatalog (renderer list).
 */
export function resolveSkillInvocation(
  integration: { support: PluginSkillSupport; invocation?: PluginSkillInvocation } | undefined,
  skillId: string,
): string | undefined {
  if (!integration || integration.support !== 'native') return undefined
  const template = integration.invocation?.explicitTemplate
  if (!template) return undefined
  return template.replace(/\{\{\s*skillId\s*\}\}/g, skillId)
}

/**
 * The character a person types to name a skill mid-prompt on this CLI — `/` on
 * claude, `$` on codex — or undefined when the CLI has no in-prompt form at all
 * (opencode's skills are named in a sentence: "Use the X skill."). A surface
 * offering a type-ahead must treat undefined as "no trigger here" and keep a
 * picker, never fall back to a borrowed `/`: typing one into codex writes a
 * character that means nothing to it.
 *
 * Read from the manifest, never inferred from `explicitTemplate` — the
 * character before `{{skillId}}` is `/`, `$`, and `e` for the three CLIs that
 * ship today, which is right twice and silently wrong once.
 */
export function resolveSkillMentionPrefix(
  integration: { support: PluginSkillSupport; invocation?: PluginSkillInvocation } | undefined,
): string | undefined {
  if (!integration || integration.support !== 'native') return undefined
  const prefix = integration.invocation?.mentionPrefix
  if (typeof prefix !== 'string') return undefined
  const trimmed = prefix.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * What picking a skill from the type-ahead inserts at the caret: the CLI's own
 * mention form (`/design-review`, `$design-review`). Undefined when the CLI
 * declares no prefix, which is the same signal `resolveSkillMentionPrefix`
 * gives — a CLI with no mention form has nothing to insert.
 *
 * Deliberately NOT `explicitTemplate`: that is the standalone form ("Use
 * $design-review.") used to seed a whole prompt, and inserting a full sentence
 * into the middle of one the user is writing would write their sentence for them.
 */
export function renderSkillMention(
  integration: { support: PluginSkillSupport; invocation?: PluginSkillInvocation } | undefined,
  skillId: string,
): string | undefined {
  const prefix = resolveSkillMentionPrefix(integration)
  if (prefix === undefined) return undefined
  const template = integration?.invocation?.mentionTemplate
  if (!template) return `${prefix}${skillId}`
  return template
    .replace(/\{\{\s*mentionPrefix\s*\}\}/g, prefix)
    .replace(/\{\{\s*skillId\s*\}\}/g, skillId)
}
