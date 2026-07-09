import type {
  BuiltinSkillTargetState,
  WorkspaceSkill,
} from '../../../shared/electron-api'
import type { PluginSkillInvocation, PluginSkillSupport } from '../../../shared/plugin-manifest'
import { resolveSkillInvocation } from '../../../shared/skill-invocation'

// The `{ support, harnessId, invocation }` shape common to PluginSkillCatalog
// (renderer plugin list) and PluginSkillIntegration (main manifest).
export type SkillIntegrationLike = {
  support: PluginSkillSupport
  harnessId: string
  invocation?: PluginSkillInvocation
}

// Renders a plugin's declared skill-invocation template. Shared by the
// terminal file-drop path ({{path}} templates) and the skill picker
// (explicit templates without a path).
export function renderSkillInvocationTemplate(
  template: string,
  values: { skillId: string; skillName: string; path?: string },
): string {
  return template
    .replace(/\{\{\s*skillId\s*\}\}/g, values.skillId)
    .replace(/\{\{\s*skillName\s*\}\}/g, values.skillName)
    .replace(/\{\{\s*path\s*\}\}/g, values.path ?? '')
}

// The explicit invocation text to hand an agent for a skill: the CLI's native
// form (`/backlog` for claude, `Use $backlog.` for codex) when the plugin
// declares native support AND the skill is actually present in that CLI's
// harness dir, otherwise a plain prompt mention every agent can follow.
export function renderSkillInvocation(input: {
  skill: Pick<WorkspaceSkill, 'id' | 'name'>
  integration?: SkillIntegrationLike
  // Whether the skill is installed where the plugin's harness reads native
  // skills (e.g. .claude/skills). Callers with a WorkspaceSkill derive it via
  // skillInstalledForHarness; default true for callers that ensure-installed.
  nativeInstalled?: boolean
}): string {
  const { skill, integration } = input
  if (input.nativeInstalled ?? true) {
    const native = resolveSkillInvocation(integration, skill.id)
    if (native) return native
  }
  return `Use the ${skill.id} skill.`
}

// Conversation-agent draft prefill (approved mockup copy): a plain sentence
// opener that leaves the caret ready for arguments. Conversation transports
// have no CLI slash contract, so the sentence form is the invocation there.
export function renderChatSkillPrefill(skill: Pick<WorkspaceSkill, 'id'>): string {
  return `Use the ${skill.id} skill to `
}

// Whether a workspace skill is present in the harness dir a plugin's native
// skill integration reads from.
export function skillInstalledForHarness(
  skill: Pick<WorkspaceSkill, 'harnesses' | 'installState'>,
  integration: SkillIntegrationLike | undefined,
): boolean {
  if (!integration) return false
  return skill.installState !== 'available'
    && skill.harnesses.some((harness) => harness === integration.harnessId)
}

// Agent-spawn patch for a "+ Skill" attachment on a terminal-CLI agent:
// builtins ride spawnSkillId (ensure-installed at the launch boundary); the
// invocation is parked at the CLI prompt unsubmitted via cliPendingInput.
export function skillSpawnAgentPatch(
  skill: WorkspaceSkill,
  integration: SkillIntegrationLike | undefined,
): { spawnSkillId?: string; cliPendingInput: string } {
  const invocation = renderSkillInvocation({
    skill,
    integration,
    nativeInstalled: skillInstalledForHarness(skill, integration),
  })
  return {
    ...(skill.source === 'builtin' ? { spawnSkillId: skill.id } : {}),
    cliPendingInput: `${invocation} `,
  }
}

// Whether any of a builtin skill's install targets is a usable native copy for
// the given plugin/harness (moved verbatim from the terminal drop path).
export function hasInstalledNativeSkillTarget(
  harnessId: string,
  pluginId: string,
  targets: readonly BuiltinSkillTargetState[],
): boolean {
  return targets.some((target) => (
    target.status === 'installed'
    || target.status === 'update-available'
    || target.status === 'modified'
    || target.status === 'local'
  ) && target.support !== 'unsupported'
    && (target.pluginId === pluginId || target.harness === harnessId))
}

// Makes a skill exist where the target agent can read it before an invocation
// lands: builtins install through the builtin skill manager (which honors each
// skill's target policy), catalog packs through skillPackInstall. Custom dirs
// are presence-only — already installed or nothing to do.
export async function ensureSkillForAgent(input: {
  workspaceRoot: string
  skill: Pick<WorkspaceSkill, 'id' | 'source' | 'installState' | 'packSlug'>
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const { workspaceRoot, skill } = input
  try {
    if (skill.source === 'builtin') {
      if (skill.installState === 'installed') return { ok: true }
      const result = await window.api.builtinSkillInstall({ workspaceRoot, skillId: skill.id })
      if (!result.ok && result.status !== 'modified' && result.status !== 'local') {
        return { ok: false, message: result.message }
      }
      return { ok: true }
    }
    if (skill.source === 'pack' && skill.installState === 'available') {
      if (!skill.packSlug) {
        return { ok: false, message: 'This skill pack has no install slug.' }
      }
      const result = await window.api.skillPackInstall({ workspaceRoot, slug: skill.packSlug })
      if (!result.ok) return { ok: false, message: result.message }
      return { ok: true }
    }
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Unable to install the skill.',
    }
  }
}
