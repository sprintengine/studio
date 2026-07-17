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
