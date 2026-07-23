import { app } from 'electron'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { isAbsolute, join, relative, resolve } from 'path'

import type { LoadedPlugin, PluginSkillInstallTarget, PluginSkillSupport } from '../shared/plugin-manifest'
import type {
  BuiltinSkill,
  BuiltinSkillInstallResult,
  BuiltinSkillStatus,
  BuiltinSkillTargetState,
  SkillPackHarness,
} from '../shared/electron-api'
import { SKILL_HARNESS_DIR } from '../shared/skill-harnesses'

const MANIFEST_FILE = '.multicode-skill.json'

const DEFAULT_HARNESSES: readonly SkillPackHarness[] = ['agents']
const ALL_NATIVE_TARGET_POLICY = 'all-native'

type ManagedSkillManifest = {
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
    // Claude-only: the Design Wizard installs this into .claude/skills before a
    // Claude Code designer session starts (both transports) and names it in the
    // startup prompt. No .agents fan-out — non-Claude CLIs never see it.
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

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
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

async function hashDirectory(root: string, ignoredNames = new Set<string>()): Promise<string> {
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

function skillHarnesses(skill: BuiltinSkill): readonly SkillPackHarness[] {
  return skill.harnesses && skill.harnesses.length > 0 ? skill.harnesses : DEFAULT_HARNESSES
}

function skillDestination(workspaceRoot: string, skillId: string, harness: SkillPackHarness): string {
  const workspace = resolve(workspaceRoot)
  const destination = resolve(workspace, SKILL_HARNESS_DIR[harness], 'skills', skillId)
  if (!isInside(workspace, destination)) {
    throw new Error('Skill destination must stay inside the workspace.')
  }
  return destination
}

function canonicalTarget(targets: BuiltinSkillTargetState[]): BuiltinSkillTargetState {
  return targets.find((target) => target.harness === 'agents' && target.destinationPath)
    ?? targets.find((target) => Boolean(target.destinationPath))
    ?? targets[0]
}

function defaultSourceRoot(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'skills')
  return join(process.cwd(), 'resources', 'skills')
}

export function createBuiltinSkillManager(options: BuiltinSkillManagerOptions = {}) {
  const sourceRoot = options.sourceRoot ?? defaultSourceRoot()
  const listPlugins = options.listPlugins ?? (() => [])

  function getSkill(id: string): BuiltinSkill | null {
    return BUILTIN_SKILLS.find((skill) => skill.id === id) ?? null
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

    const manifest = await readJson<ManagedSkillManifest>(join(destinationPath, MANIFEST_FILE))
    if (!manifest || manifest.id !== skill.id || manifest.source !== 'multicode-builtin') {
      return { ...base, destinationPath, status: 'local' }
    }

    const currentHash = await hashDirectory(destinationPath, new Set([MANIFEST_FILE]))
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

    const sourceHash = await hashDirectory(sourcePath)
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
        message: 'A local skill exists but is not managed by Multicode.',
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
        message: 'The workspace skill has local changes. Multicode will not overwrite it.',
      }
    }

    const sourcePath = getSourcePath(status.skill.id)
    const sourceHash = await hashDirectory(sourcePath)
    const now = new Date().toISOString()

    for (const target of actionable) {
      if (!target.destinationPath) continue
      if (target.status !== 'missing') {
        await rm(target.destinationPath, { recursive: true, force: true })
      }
      await mkdir(join(target.destinationPath, '..'), { recursive: true })
      await cp(sourcePath, target.destinationPath, { recursive: true, force: false, errorOnExist: true })
      const installedSkillHash = await hashDirectory(target.destinationPath)
      const manifest: ManagedSkillManifest = {
        id: status.skill.id,
        source: 'multicode-builtin',
        version: status.skill.version,
        sourceHash,
        installedSkillHash,
        installedAt: now,
        updatedAt: now,
      }
      await writeFile(
        join(target.destinationPath, MANIFEST_FILE),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf-8'
      )
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
  if (!isInside(root, destination)) return null
  return destination
}
