import { app } from 'electron'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { join, relative, resolve } from 'path'

import type { LoadedPlugin, PluginSkillInstallTarget, PluginSkillSupport } from '../shared/plugin-manifest'
import type {
  BuiltinSkill,
  BuiltinSkillInstallResult,
  BuiltinSkillStatus,
  BuiltinSkillTargetState,
  SkillHarness,
} from '../shared/electron-api'
import { SKILL_HARNESS_DIR } from '../shared/skill-harnesses'
import { STUDIO_MARKETPLACE_RESOURCE_DIR, STUDIO_SKILLS_PLUGIN_ID } from './skills/studio-plugin'
import { isPathInsideOrEqual } from './path-containment'

// The marker a managed copy carries. Exported because the attach path
// (src/main/agent-skill-installer.ts) reads and writes the same file, and two
// spellings of this name would be two conventions.
export const MANAGED_SKILL_MANIFEST_FILE = '.multicode-skill.json'

const DEFAULT_HARNESSES: readonly SkillHarness[] = ['agents']
const ALL_NATIVE_TARGET_POLICY = 'all-native'

export type ManagedSkillManifest = {
  id: string
  source: 'multicode-builtin'
  version: string
  sourceHash: string
  installedSkillHash: string
  installedAt: string
  updatedAt: string
}

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  {
    id: 'workspace-knowledge',
    name: 'Workspace Knowledge',
    version: '1.0.0',
    description: 'Read and update a workspace-local Markdown knowledge graph.',
  },
  {
    id: 'knowledge-grill',
    name: 'Knowledge Grill',
    version: '1.0.0',
    description: 'Stress-test plans against workspace knowledge and current code.',
  },
  {
    id: 'debug',
    name: 'Debug',
    version: '1.0.0',
    description: 'Debug bugs and regressions through a file-backed state machine that survives context compaction.',
    // Debug Mode delivers this skill's full contract to the agent, so it must
    // land in each CLI's native skill dir (e.g. .claude/skills, .codex/skills),
    // not just .agents/. The spawn path ensure-installs it when Debug Mode is on.
    targetPolicy: ALL_NATIVE_TARGET_POLICY,
  },
  {
    id: 'behavior-first-testing',
    name: 'Behavior First Testing',
    version: '1.0.0',
    description: 'Design tests around observable behavior through public interfaces.',
  },
  {
    id: 'prototype',
    name: 'Prototype',
    version: '1.0.0',
    description: 'Build clearly throwaway prototypes for design and workflow questions.',
  },
  {
    id: 'architecture-deepening',
    name: 'Architecture Deepening',
    version: '1.0.0',
    description: 'Find focused architecture improvements for locality and testability.',
  },
  {
    id: 'handoff',
    name: 'Handoff',
    version: '1.0.0',
    description: 'Create concise continuation handoffs for another agent or session.',
  },
  {
    id: 'backlog',
    name: 'Backlog',
    version: '1.2.0',
    description: 'Take, work, survey, or triage Backlog items with truthful lifecycle status.',
    targetPolicy: ALL_NATIVE_TARGET_POLICY,
  },
  {
    id: 'use-railway',
    name: 'Use Railway',
    version: '1.0.0',
    description: 'Explore and operate a Railway environment from chat: auth check, projects, deploy status, health, and follow-ups.',
    // The Railway connector installs this into whichever CLI it launches so the
    // seed prompt can invoke it natively (.claude/skills, .codex/skills), not
    // just .agents/. launchConnectorChat ensure-installs it at spawn.
    targetPolicy: ALL_NATIVE_TARGET_POLICY,
  },
  {
    id: 'use-codex',
    name: 'Use Codex',
    version: '1.0.0',
    description:
      'Delegate non-UI implementation, second-opinion reviews, image generation, and chores to the local Codex CLI.',
    // Deliberately not all-native: installing "delegate to Codex" into
    // .codex/skills would tell Codex to delegate to itself. Static targets
    // only — .agents plus Claude Code's native skill dir.
    harnesses: ['agents', 'claude'],
  },
  {
    id: 'review-guide',
    name: 'Review Guide',
    version: '1.0.0',
    description: 'Walk a human reviewer through a code change, and answer their questions about it.',
    // The guide runs as an ordinary terminal agent under whichever CLI the
    // reviewer picked, so the skill must land in that CLI's native skill dir
    // (.claude/skills, .codex/skills, ...), not just .agents/. The review guide
    // service ensure-installs it at spawn via spawnSkillId.
    targetPolicy: ALL_NATIVE_TARGET_POLICY,
  },
  {
    id: 'frontend-design',
    name: 'Frontend Design',
    version: '1.0.0',
    description:
      'Craft guidance for authoring calm, deliberate HTML mockups and design-system bundles instead of generic AI-generated UI.',
    // Claude-only: it installs into .claude/skills and is named in the prompt
    // that wants it. No .agents fan-out — non-Claude CLIs never see it.
    harnesses: ['claude'],
  },
]

type BuiltinSkillManagerOptions = {
  sourceRoot?: string
  listPlugins?: () => LoadedPlugin[]
}

type SkillTargetDescriptor = {
  harness: string
  destinationPath?: string
  status?: 'prompt-shim' | 'unsupported'
  pluginId?: string
  displayName?: string
  support?: PluginSkillSupport
  installScope?: 'workspace' | 'user'
  format?: string
  restartRequired?: boolean
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T
  } catch {
    return null
  }
}

/**
 * Content identity of a skill directory: every file's path and bytes, in a
 * stable order. Exported because the attach path compares a source against an
 * installed copy with it, and two different hashes of "the same" directory
 * would make an unchanged copy look modified. Pass `MANAGED_SKILL_MANIFEST_FILE`
 * to ignore the marker, which is written after the hash is taken.
 */
export async function hashSkillDirectory(root: string, ignoredNames = new Set<string>()): Promise<string> {
  const hash = createHash('sha256')

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (ignoredNames.has(entry.name)) continue
      const fullPath = join(dir, entry.name)
      const rel = relative(root, fullPath).replace(/\\/g, '/')
      if (entry.isDirectory()) {
        hash.update(`dir:${rel}\n`)
        await visit(fullPath)
      } else if (entry.isFile()) {
        hash.update(`file:${rel}\n`)
        hash.update(await readFile(fullPath))
        hash.update('\n')
      }
    }
  }

  await visit(root)
  return hash.digest('hex')
}

/**
 * Replace `destinationDir` with a copy of `sourceDir`, parents included. The
 * two skill install paths — this manager's policy fan-out and the pane's attach
 * (src/main/agent-skill-installer.ts) — share it so a skill copy is made one
 * way. Whether the destination may be replaced at all is the caller's decision:
 * both refuse to overwrite a directory Multicode did not write.
 */
export async function copySkillDirectory(sourceDir: string, destinationDir: string): Promise<void> {
  await rm(destinationDir, { recursive: true, force: true })
  await mkdir(join(destinationDir, '..'), { recursive: true })
  await cp(sourceDir, destinationDir, { recursive: true, force: false, errorOnExist: true })
}

/**
 * Stamp a freshly written copy of a bundled skill with the manifest
 * `getTargetState` reads back. Without it the copy is indistinguishable from a
 * hand-made directory, and every later install would refuse to touch it.
 */
export async function writeManagedSkillManifest(input: {
  destinationDir: string
  skill: Pick<BuiltinSkill, 'id' | 'version'>
  sourceHash: string
  now?: string
}): Promise<void> {
  const timestamp = input.now ?? new Date().toISOString()
  const manifest: ManagedSkillManifest = {
    id: input.skill.id,
    source: 'multicode-builtin',
    version: input.skill.version,
    sourceHash: input.sourceHash,
    // Taken before the manifest exists, which is also how it is re-checked.
    installedSkillHash: await hashSkillDirectory(input.destinationDir),
    installedAt: timestamp,
    updatedAt: timestamp,
  }
  await writeFile(join(input.destinationDir, MANAGED_SKILL_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
}

export function findBuiltinSkill(skillId: string): BuiltinSkill | null {
  return BUILTIN_SKILLS.find((skill) => skill.id === skillId) ?? null
}

function skillHarnesses(skill: BuiltinSkill): readonly SkillHarness[] {
  return skill.harnesses && skill.harnesses.length > 0 ? skill.harnesses : DEFAULT_HARNESSES
}

function skillDestination(workspaceRoot: string, skillId: string, harness: SkillHarness): string {
  const workspace = resolve(workspaceRoot)
  const destination = resolve(workspace, SKILL_HARNESS_DIR[harness], 'skills', skillId)
  if (!isPathInsideOrEqual(workspace, destination)) {
    throw new Error('Skill destination must stay inside the workspace.')
  }
  return destination
}

function canonicalTarget(targets: BuiltinSkillTargetState[]): BuiltinSkillTargetState {
  return targets.find((target) => target.harness === 'agents' && target.destinationPath)
    ?? targets.find((target) => Boolean(target.destinationPath))
    ?? targets[0]
}

/**
 * Where the skills the app ships live, bundled or in the checkout.
 *
 * They moved out of `resources/skills` and into `studio-plugin/studio-skills`
 * with the studio-marketplace ruling (2026-09-06): they are a plugin in the
 * marketplace we publish, which is what lets the Skills catalogue list them
 * from the same source the Plugins catalogue reads instead of from a folder
 * scan nothing else could see. This service still copies them from disk — it is
 * the "attach a built-in skill to this agent" path, not the catalogue — and the
 * directory is the only thing about it that changed.
 */
export function builtinSkillSourceRoot(): string {
  const relative = [STUDIO_MARKETPLACE_RESOURCE_DIR, STUDIO_SKILLS_PLUGIN_ID, 'skills']
  if (app.isPackaged) return join(process.resourcesPath, ...relative)
  return join(process.cwd(), 'resources', ...relative)
}

export function createBuiltinSkillManager(options: BuiltinSkillManagerOptions = {}) {
  const sourceRoot = options.sourceRoot ?? builtinSkillSourceRoot()
  const listPlugins = options.listPlugins ?? (() => [])

  function getSkill(id: string): BuiltinSkill | null {
    return findBuiltinSkill(id)
  }

  function getSourcePath(id: string): string {
    return join(sourceRoot, id)
  }

  function staticSkillTargets(workspaceRoot: string, skill: BuiltinSkill): SkillTargetDescriptor[] {
    return skillHarnesses(skill).map((harness) => ({
      harness,
      destinationPath: skillDestination(workspaceRoot, skill.id, harness),
      support: 'native',
      installScope: 'workspace',
      format: harness,
    }))
  }

  function pluginSkillTargets(workspaceRoot: string, skill: BuiltinSkill): SkillTargetDescriptor[] {
    if (skill.targetPolicy !== ALL_NATIVE_TARGET_POLICY) return []
    const targets: SkillTargetDescriptor[] = []
    for (const plugin of listPlugins()) {
      const integration = plugin.manifest.skillIntegration
      if (!integration) {
        targets.push({
          harness: plugin.manifest.id,
          pluginId: plugin.manifest.id,
          displayName: plugin.manifest.displayName,
          support: 'unsupported',
          status: 'unsupported',
        })
        continue
      }

      if (integration.support !== 'native') {
        targets.push({
          harness: integration.harnessId,
          pluginId: plugin.manifest.id,
          displayName: plugin.manifest.displayName,
          support: integration.support,
          status: integration.support === 'prompt-shim' ? 'prompt-shim' : 'unsupported',
        })
        continue
      }

      for (const installTarget of integration.installTargets ?? []) {
        const destinationPath = renderSkillInstallTargetPath({
          workspaceRoot,
          skillId: skill.id,
          target: installTarget,
        })
        if (!destinationPath) continue
        targets.push({
          harness: integration.harnessId,
          destinationPath,
          pluginId: plugin.manifest.id,
          displayName: plugin.manifest.displayName,
          support: 'native',
          installScope: installTarget.scope,
          format: installTarget.format,
          restartRequired: installTarget.restartRequired === true,
        })
      }
    }
    return targets
  }

  function skillTargets(workspaceRoot: string, skill: BuiltinSkill): SkillTargetDescriptor[] {
    const seen = new Set<string>()
    const result: SkillTargetDescriptor[] = []
    for (const target of [...staticSkillTargets(workspaceRoot, skill), ...pluginSkillTargets(workspaceRoot, skill)]) {
      // Path-bearing targets dedupe on the resolved destination alone: several
      // plugins can render the same native path (claude-code and zai both
      // target .claude/skills/<id>), and install() cp's each listed target with
      // errorOnExist — a duplicate path means the second copy dies EEXIST right
      // after the first one succeeds. First declarer wins; status-only targets
      // (prompt-shim/unsupported) keep their per-plugin identity.
      const key = target.destinationPath
        ? `path:${target.destinationPath}`
        : `${target.pluginId ?? ''}:${target.harness}:${target.status ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push(target)
    }
    return result
  }

  async function getTargetState(
    skill: BuiltinSkill,
    sourceHash: string,
    target: SkillTargetDescriptor
  ): Promise<BuiltinSkillTargetState> {
    const base = {
      harness: target.harness,
      ...(target.destinationPath ? { destinationPath: target.destinationPath } : {}),
      ...(target.pluginId ? { pluginId: target.pluginId } : {}),
      ...(target.displayName ? { displayName: target.displayName } : {}),
      ...(target.support ? { support: target.support } : {}),
      ...(target.installScope ? { installScope: target.installScope } : {}),
      ...(target.format ? { format: target.format } : {}),
      ...(target.restartRequired ? { restartRequired: true } : {}),
    }
    if (target.status === 'prompt-shim' || target.status === 'unsupported') {
      return { ...base, status: target.status }
    }
    const destinationPath = target.destinationPath
    if (!destinationPath) return { ...base, status: 'unsupported' }
    if (!(await pathExists(destinationPath))) {
      return { ...base, destinationPath, status: 'missing' }
    }

    const manifest = await readJson<ManagedSkillManifest>(join(destinationPath, MANAGED_SKILL_MANIFEST_FILE))
    if (!manifest || manifest.id !== skill.id || manifest.source !== 'multicode-builtin') {
      return { ...base, destinationPath, status: 'local' }
    }

    const currentHash = await hashSkillDirectory(destinationPath, new Set([MANAGED_SKILL_MANIFEST_FILE]))
    if (currentHash !== manifest.installedSkillHash) {
      return { ...base, destinationPath, status: 'modified', installedVersion: manifest.version }
    }

    if (sourceHash !== manifest.sourceHash || manifest.version !== skill.version) {
      return { ...base, destinationPath, status: 'update-available', installedVersion: manifest.version }
    }

    return { ...base, destinationPath, status: 'installed', installedVersion: manifest.version }
  }

  async function getStatus(workspaceRoot: string | null, skillId: string): Promise<BuiltinSkillStatus> {
    const skill = getSkill(skillId)
    if (!skill) return { ok: false, status: 'unknown-skill', skillId, message: `Unknown built-in skill: ${skillId}` }
    if (!workspaceRoot) return { ok: false, status: 'missing-workspace', skillId, message: 'Workspace root is required.' }

    const sourcePath = getSourcePath(skill.id)
    if (!(await pathExists(sourcePath))) {
      return { ok: false, status: 'missing-source', skillId, message: `Built-in skill source is missing: ${skill.id}` }
    }

    const sourceHash = await hashSkillDirectory(sourcePath)
    const targets: BuiltinSkillTargetState[] = []
    for (const target of skillTargets(workspaceRoot, skill)) {
      targets.push(await getTargetState(skill, sourceHash, target))
    }

    const destinationPath = canonicalTarget(targets).destinationPath ?? ''
    const installedVersion =
      targets.find((target) => target.installedVersion)?.installedVersion ?? skill.version

    // Aggregate by actionability: anything installable wins over anything
    // merely protected, so install stays offered while modified/local copies
    // are skipped rather than blocking every other harness.
    if (targets.some((target) => target.status === 'missing')) {
      return { ok: true, status: 'missing', skill, destinationPath, targets }
    }
    if (targets.some((target) => target.status === 'update-available')) {
      return { ok: true, status: 'update-available', skill, destinationPath, installedVersion, targets }
    }
    if (targets.some((target) => target.status === 'modified')) {
      return { ok: true, status: 'modified', skill, destinationPath, installedVersion, targets }
    }
    if (targets.some((target) => target.status === 'local')) {
      return {
        ok: true,
        status: 'local',
        skill,
        destinationPath,
        message: 'A local skill exists but is not managed here.',
        targets,
      }
    }
    return { ok: true, status: 'installed', skill, destinationPath, installedVersion, targets }
  }

  async function install(workspaceRoot: string | null, skillId: string): Promise<BuiltinSkillInstallResult> {
    const status = await getStatus(workspaceRoot, skillId)
    if (!status.ok) return status

    const actionable = status.targets.filter(
      (target) => Boolean(target.destinationPath)
        && (target.status === 'missing' || target.status === 'installed' || target.status === 'update-available')
    )
    const skipped = status.targets.filter(
      (target) => Boolean(target.destinationPath) && (target.status === 'modified' || target.status === 'local')
    )
    if (actionable.length === 0) {
      return {
        ok: false,
        status: skipped.every((target) => target.status === 'local') ? 'local' : 'modified',
        skillId,
        message: 'The workspace skill has local changes. It will not be overwritten.',
      }
    }

    const sourcePath = getSourcePath(status.skill.id)
    const sourceHash = await hashSkillDirectory(sourcePath)
    const now = new Date().toISOString()

    for (const target of actionable) {
      if (!target.destinationPath) continue
      await copySkillDirectory(sourcePath, target.destinationPath)
      await writeManagedSkillManifest({
        destinationDir: target.destinationPath,
        skill: status.skill,
        sourceHash,
        now,
      })
    }

    return {
      ok: true,
      status: actionable.every((target) => target.status === 'missing') ? 'installed' : 'updated',
      skill: status.skill,
      destinationPath: canonicalTarget(status.targets).destinationPath ?? '',
      ...(skipped.length > 0 ? { skipped } : {}),
    }
  }

  return {
    list: async (): Promise<BuiltinSkill[]> => BUILTIN_SKILLS,
    getStatus,
    install,
  }
}

function renderSkillInstallTargetPath(input: {
  workspaceRoot: string
  skillId: string
  target: PluginSkillInstallTarget
}): string | null {
  const workspace = resolve(input.workspaceRoot)
  const home = resolve(homedir())
  const rendered = input.target.path
    .replace(/\{\{\s*workspaceRoot\s*\}\}/g, workspace)
    .replace(/\{\{\s*home\s*\}\}/g, home)
    .replace(/\{\{\s*skillId\s*\}\}/g, input.skillId)
  const destination = resolve(input.target.scope === 'workspace' ? workspace : home, rendered)
  const root = input.target.scope === 'workspace' ? workspace : home
  if (!isPathInsideOrEqual(root, destination)) return null
  return destination
}
