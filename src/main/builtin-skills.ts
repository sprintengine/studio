import { app } from 'electron'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { createHash } from 'crypto'
import { isAbsolute, join, relative, resolve } from 'path'

import type {
  BuiltinSkill,
  BuiltinSkillInstallResult,
  BuiltinSkillStatus,
} from '../shared/electron-api'

const MANIFEST_FILE = '.multicode-skill.json'

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
]

type BuiltinSkillManagerOptions = {
  sourceRoot?: string
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

function skillDestination(workspaceRoot: string, skillId: string): string {
  const workspace = resolve(workspaceRoot)
  const destination = resolve(workspace, '.agents', 'skills', skillId)
  if (!isInside(workspace, destination)) {
    throw new Error('Skill destination must stay inside the workspace.')
  }
  return destination
}

function defaultSourceRoot(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'skills')
  return join(process.cwd(), 'resources', 'skills')
}

export function createBuiltinSkillManager(options: BuiltinSkillManagerOptions = {}) {
  const sourceRoot = options.sourceRoot ?? defaultSourceRoot()

  function getSkill(id: string): BuiltinSkill | null {
    return BUILTIN_SKILLS.find((skill) => skill.id === id) ?? null
  }

  function getSourcePath(id: string): string {
    return join(sourceRoot, id)
  }

  async function getStatus(workspaceRoot: string | null, skillId: string): Promise<BuiltinSkillStatus> {
    const skill = getSkill(skillId)
    if (!skill) return { ok: false, status: 'unknown-skill', skillId, message: `Unknown built-in skill: ${skillId}` }
    if (!workspaceRoot) return { ok: false, status: 'missing-workspace', skillId, message: 'Workspace root is required.' }

    const sourcePath = getSourcePath(skill.id)
    if (!(await pathExists(sourcePath))) {
      return { ok: false, status: 'missing-source', skillId, message: `Built-in skill source is missing: ${skill.id}` }
    }

    const destinationPath = skillDestination(workspaceRoot, skill.id)
    if (!(await pathExists(destinationPath))) {
      return { ok: true, status: 'missing', skill, destinationPath }
    }

    const manifestPath = join(destinationPath, MANIFEST_FILE)
    const manifest = await readJson<ManagedSkillManifest>(manifestPath)
    if (!manifest || manifest.id !== skill.id || manifest.source !== 'multicode-builtin') {
      return { ok: true, status: 'local', skill, destinationPath, message: 'A local skill exists but is not managed by Multicode.' }
    }

    const currentHash = await hashDirectory(destinationPath, new Set([MANIFEST_FILE]))
    if (currentHash !== manifest.installedSkillHash) {
      return { ok: true, status: 'modified', skill, destinationPath, installedVersion: manifest.version }
    }

    const sourceHash = await hashDirectory(sourcePath)
    if (sourceHash !== manifest.sourceHash || manifest.version !== skill.version) {
      return { ok: true, status: 'update-available', skill, destinationPath, installedVersion: manifest.version }
    }

    return { ok: true, status: 'installed', skill, destinationPath, installedVersion: manifest.version }
  }

  async function install(workspaceRoot: string | null, skillId: string): Promise<BuiltinSkillInstallResult> {
    const status = await getStatus(workspaceRoot, skillId)
    if (!status.ok) return status
    if (status.status === 'local' || status.status === 'modified') {
      return {
        ok: false,
        status: status.status,
        skillId,
        message: 'The workspace skill has local changes. Multicode will not overwrite it.',
      }
    }

    const sourcePath = getSourcePath(status.skill.id)
    const destinationPath = status.destinationPath
    const sourceHash = await hashDirectory(sourcePath)

    if (status.status !== 'missing') {
      await rm(destinationPath, { recursive: true, force: true })
    }

    await mkdir(join(destinationPath, '..'), { recursive: true })
    await cp(sourcePath, destinationPath, { recursive: true, force: false, errorOnExist: true })
    const installedSkillHash = await hashDirectory(destinationPath)
    const now = new Date().toISOString()
    const manifest: ManagedSkillManifest = {
      id: status.skill.id,
      source: 'multicode-builtin',
      version: status.skill.version,
      sourceHash,
      installedSkillHash,
      installedAt: now,
      updatedAt: now,
    }
    await writeFile(join(destinationPath, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')

    return {
      ok: true,
      status: status.status === 'missing' ? 'installed' : 'updated',
      skill: status.skill,
      destinationPath,
    }
  }

  return {
    list: async (): Promise<BuiltinSkill[]> => BUILTIN_SKILLS,
    getStatus,
    install,
  }
}
