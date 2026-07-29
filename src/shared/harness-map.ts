// The one place a harness → directory mapping is derived.
//
// A *harness* is the skill format and directory a family of CLIs shares:
// `claude-code`, `kimi-claude` and `zai` all declare `harnessId: "claude"` and
// all read `.claude/skills`. Reading and writing key off the harness, then
// attribute the result to every CLI bound to it — reading once per harness
// instead of once per CLI is both cheaper and the only way a skill is not
// counted three times.
//
// Every fact here comes from `resources/plugins/<id>/plugin.json`. Adding a
// thirteenth CLI must require no change to this file: the directory is parsed
// out of the declared `installTargets[].path` template, never written as a
// literal. Node-free so main and renderer share one map.

import type {
  PluginRegistryListEntry,
  PluginSkillFormat,
  PluginSkillSupport,
} from './plugin-manifest'

export type HarnessBinding = {
  harnessId: string
  /**
   * Workspace-relative skills directory (e.g. `.claude/skills`), or null when
   * the plugin declares no workspace install target — nothing to read, which is
   * different from a directory that failed to read.
   */
  skillsDir: string | null
  skillFormat: PluginSkillFormat | null
  restartRequired: boolean
  /** Every CLI bound to this harness, in registry order. */
  pluginIds: string[]
  /**
   * On a `byPlugin` entry: that plugin's own declared support. On a `byHarness`
   * entry: the strongest support declared by the CLIs bound to it, since the
   * harness is readable natively as soon as one of them says so.
   */
  support: PluginSkillSupport
}

export type HarnessMap = {
  byHarness: Map<string, HarnessBinding>
  byPlugin: Map<string, HarnessBinding>
}

const WORKSPACE_ROOT_PREFIX = /^\{\{\s*workspaceRoot\s*\}\}\//
const SKILL_ID_SUFFIX = /\/\{\{\s*skillId\s*\}\}$/

const SUPPORT_RANK: Record<PluginSkillSupport, number> = {
  unsupported: 0,
  'prompt-shim': 1,
  native: 2,
}

/**
 * The workspace-relative directory a declared install-target template installs
 * into: `{{workspaceRoot}}/.claude/skills/{{skillId}}` → `.claude/skills`.
 *
 * Returns null for a template this cannot read literally — an unresolved
 * placeholder, an absolute path, or a path escaping the workspace root. A user
 * plugin is third-party input, and a directory this hands back is joined onto a
 * real workspace root and read.
 */
export function skillsDirFromTemplate(template: string): string | null {
  if (!WORKSPACE_ROOT_PREFIX.test(template) || !SKILL_ID_SUFFIX.test(template)) return null
  const dir = template.replace(WORKSPACE_ROOT_PREFIX, '').replace(SKILL_ID_SUFFIX, '')
  if (!dir || dir.includes('{{') || dir.startsWith('/') || /^[A-Za-z]:/.test(dir)) return null
  const segments = dir.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null
  return dir
}

// Memoised on the plugin list itself, which is the only key that can never go
// stale: a reloaded registry hands out a new array, so the map is rebuilt.
// Callers holding one list across renders (the renderer's plugin catalog) get
// the cached map; callers that re-list per call rebuild, which is a dozen
// regex matches.
const memo = new WeakMap<object, HarnessMap>()

export function buildHarnessMap(plugins: readonly PluginRegistryListEntry[]): HarnessMap {
  const cached = memo.get(plugins)
  if (cached) return cached

  const byHarness = new Map<string, HarnessBinding>()
  for (const plugin of plugins) {
    const integration = plugin.skillIntegration
    if (!integration) continue

    const existing = byHarness.get(integration.harnessId)
    const workspaceTarget = integration.installTargets.find((target) => target.scope === 'workspace')
    const skillsDir = workspaceTarget ? skillsDirFromTemplate(workspaceTarget.path) : null
    const restartRequired = integration.installTargets.some((target) => target.restartRequired)

    if (!existing) {
      byHarness.set(integration.harnessId, {
        harnessId: integration.harnessId,
        skillsDir,
        skillFormat: skillsDir && workspaceTarget ? workspaceTarget.format : null,
        restartRequired,
        pluginIds: [plugin.id],
        support: integration.support,
      })
      continue
    }

    existing.pluginIds.push(plugin.id)
    existing.restartRequired = existing.restartRequired || restartRequired
    if (SUPPORT_RANK[integration.support] > SUPPORT_RANK[existing.support]) {
      existing.support = integration.support
    }
    // First declaration of the directory wins; a later plugin on the same
    // harness declaring a different one is a manifest defect, and silently
    // switching directories mid-list would make the resolved answer depend on
    // registry order.
    if (!existing.skillsDir && skillsDir && workspaceTarget) {
      existing.skillsDir = skillsDir
      existing.skillFormat = workspaceTarget.format
    }
  }

  // A plugin's own support is what the surface reports for it, so each plugin
  // gets its own view of the shared binding rather than the harness-wide one.
  const byPlugin = new Map<string, HarnessBinding>()
  for (const plugin of plugins) {
    const integration = plugin.skillIntegration
    if (!integration) continue
    const binding = byHarness.get(integration.harnessId)
    if (!binding) continue
    byPlugin.set(
      plugin.id,
      binding.support === integration.support ? binding : { ...binding, support: integration.support },
    )
  }

  const map: HarnessMap = { byHarness, byPlugin }
  memo.set(plugins, map)
  return map
}
