import type { PluginSkillInvocation, PluginSkillSupport } from './plugin-manifest'

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
