import { app } from 'electron'
import { spawn } from 'child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import type {
  SkillPackCatalogEntry,
  SkillPackCatalogResult,
  SkillPackEntry,
  SkillPackHarness,
  SkillPackInstallInput,
  SkillPackInstallResult,
  SkillPackListInstalledInput,
  SkillPackListInstalledResult,
  SkillPackRemoveInput,
  SkillPackRemoveResult,
} from '../shared/electron-api'
import { SKILL_HARNESS_DIR, SKILL_PACK_HARNESSES } from '../shared/skill-harnesses'

const ALL_HARNESSES = SKILL_PACK_HARNESSES
const HARNESS_DIR = SKILL_HARNESS_DIR

export type SkillPackService = {
  listCatalog(): SkillPackCatalogResult
  listInstalled(input: SkillPackListInstalledInput): Promise<SkillPackListInstalledResult>
  install(input: SkillPackInstallInput): Promise<SkillPackInstallResult>
  remove(input: SkillPackRemoveInput): Promise<SkillPackRemoveResult>
}

export function createSkillPackService(): SkillPackService {
  return {
    listCatalog,
    listInstalled,
    install,
    remove,
  }
}

function listCatalog(): SkillPackCatalogResult {
  try {
    const catalogPath = findCatalogPath()
    if (!catalogPath) {
      return { ok: false, message: 'Bundled skill-pack catalog was not found.' }
    }
    const raw = JSON.parse(readFileSync(catalogPath, 'utf8')) as { packs?: unknown }
    if (!Array.isArray(raw.packs)) {
      return { ok: false, message: 'Bundled skill-pack catalog is missing its packs array.' }
    }
    const packs = raw.packs
      .map(normalizeCatalogEntry)
      .filter((pack): pack is SkillPackCatalogEntry => Boolean(pack))
    return { ok: true, packs }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Unable to read bundled skill-pack catalog.',
    }
  }
}

function findCatalogPath(): string | null {
  const candidates = app.isPackaged
    ? [
        join(process.resourcesPath, 'skill-packs', 'catalog.json'),
        join(app.getAppPath(), 'resources', 'skill-packs', 'catalog.json'),
      ]
    : [
        join(process.cwd(), 'resources', 'skill-packs', 'catalog.json'),
        join(app.getAppPath(), 'resources', 'skill-packs', 'catalog.json'),
        join(__dirname, '..', '..', 'resources', 'skill-packs', 'catalog.json'),
        join(__dirname, '..', '..', '..', 'resources', 'skill-packs', 'catalog.json'),
      ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

async function listInstalled(
  input: SkillPackListInstalledInput,
): Promise<SkillPackListInstalledResult> {
  const workspaceRoot = input.workspaceRoot?.trim()
  if (!workspaceRoot || !existsSync(workspaceRoot)) {
    return { ok: false, message: 'Workspace root does not exist.' }
  }
  const catalogResult = listCatalog()
  const catalog = catalogResult.ok ? catalogResult.packs : []

  const installedById = new Map<string, SkillPackEntry>()
  for (const harness of ALL_HARNESSES) {
    const skillsDir = join(workspaceRoot, HARNESS_DIR[harness], 'skills')
    if (!existsSync(skillsDir)) continue
    let dirs: string[] = []
    try {
      dirs = readdirSync(skillsDir).filter((name) => {
        try {
          return statSync(join(skillsDir, name)).isDirectory()
        } catch {
          return false
        }
      })
    } catch {
      continue
    }
    for (const dirName of dirs) {
      const entry = installedById.get(dirName) ?? buildEntryFromInstall(dirName, catalog)
      if (!entry.harnesses.includes(harness)) {
        entry.harnesses = [...entry.harnesses, harness]
      }
      installedById.set(entry.id, entry)
    }
  }
  return { ok: true, installed: Array.from(installedById.values()) }
}

function buildEntryFromInstall(
  installedDirName: string,
  catalog: SkillPackCatalogEntry[],
): SkillPackEntry {
  const fromCatalog = catalog.find(
    (pack) => (pack.installedDirName ?? pack.id) === installedDirName,
  )
  if (fromCatalog) {
    return {
      id: fromCatalog.id,
      slug: fromCatalog.slug,
      name: fromCatalog.name,
      category: fromCatalog.category,
      description: fromCatalog.description,
      version: fromCatalog.version,
      sourceUrl: fromCatalog.sourceUrl,
      installedDirName,
      harnesses: [],
      source: 'bundled',
    }
  }
  return {
    id: installedDirName,
    slug: installedDirName,
    name: installedDirName,
    installedDirName,
    harnesses: [],
    source: 'custom',
  }
}

async function install(input: SkillPackInstallInput): Promise<SkillPackInstallResult> {
  const workspaceRoot = input.workspaceRoot?.trim()
  if (!workspaceRoot || !existsSync(workspaceRoot)) {
    return { ok: false, message: 'Workspace root does not exist.' }
  }
  const slug = input.slug?.trim()
  if (!slug) {
    return { ok: false, message: 'Slug is required.' }
  }

  const result = await runNpx(['--yes', 'skills@latest', 'add', slug], workspaceRoot)
  if (result.code !== 0) {
    return {
      ok: false,
      message: result.stderr.trim() || `skills add ${slug} exited with code ${result.code}.`,
      log: result.stdout + result.stderr,
    }
  }

  const installedAt = new Date().toISOString()
  const installedDirName = input.installedDirName ?? slug.split('/').pop() ?? slug
  const harnesses = detectHarnesses(workspaceRoot, installedDirName, input.harnesses)

  const installed: SkillPackEntry = {
    id: installedDirName,
    slug,
    name: installedDirName,
    installedDirName,
    harnesses,
    source: 'bundled',
    installedAt,
  }
  return { ok: true, installed, log: result.stdout + result.stderr }
}

async function remove(input: SkillPackRemoveInput): Promise<SkillPackRemoveResult> {
  const workspaceRoot = input.workspaceRoot?.trim()
  if (!workspaceRoot || !existsSync(workspaceRoot)) {
    return { ok: false, message: 'Workspace root does not exist.' }
  }
  const slug = input.slug?.trim()
  if (!slug) {
    return { ok: false, message: 'Slug is required.' }
  }

  const dirName = input.installedDirName ?? slug.split('/').pop() ?? slug
  const targetHarnesses = input.harnesses && input.harnesses.length > 0
    ? input.harnesses
    : ALL_HARNESSES
  const removedPaths: string[] = []
  const errors: string[] = []

  for (const harness of targetHarnesses) {
    const skillDir = join(workspaceRoot, HARNESS_DIR[harness], 'skills', dirName)
    if (!existsSync(skillDir)) continue
    try {
      rmSync(skillDir, { recursive: true, force: true })
      removedPaths.push(skillDir)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `Failed to remove ${skillDir}.`)
    }
  }

  if (removedPaths.length === 0 && errors.length === 0) {
    return {
      ok: false,
      message: `No installed copies of ${dirName} were found in this workspace.`,
    }
  }
  if (errors.length > 0) {
    return { ok: false, message: errors.join('\n'), log: removedPaths.join('\n') }
  }
  return { ok: true, slug, log: removedPaths.join('\n') }
}

function detectHarnesses(
  workspaceRoot: string,
  installedDirName: string,
  hint?: SkillPackHarness[],
): SkillPackHarness[] {
  const detected = ALL_HARNESSES.filter((harness) =>
    existsSync(join(workspaceRoot, HARNESS_DIR[harness], 'skills', installedDirName)),
  )
  if (detected.length > 0) return detected
  return hint ?? []
}

type RunResult = { code: number; stdout: string; stderr: string }

function runNpx(args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('npx', args, {
      cwd,
      shell: process.platform === 'win32',
      env: { ...process.env, npm_config_yes: 'true' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      resolve({ code: 1, stdout, stderr: stderr + (error.message ?? String(error)) })
    })
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

function normalizeCatalogEntry(value: unknown): SkillPackCatalogEntry | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<SkillPackCatalogEntry>
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const slug = typeof raw.slug === 'string' ? raw.slug.trim() : ''
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!id || !slug || !name) return null
  const harnesses = Array.isArray(raw.harnesses)
    ? raw.harnesses.filter((h): h is SkillPackHarness => ALL_HARNESSES.includes(h as SkillPackHarness))
    : []
  return {
    id,
    slug,
    name,
    category: typeof raw.category === 'string' ? raw.category.trim() || undefined : undefined,
    description: typeof raw.description === 'string' ? raw.description.trim() || undefined : undefined,
    version: typeof raw.version === 'string' ? raw.version.trim() || undefined : undefined,
    sourceUrl: typeof raw.sourceUrl === 'string' ? raw.sourceUrl.trim() || undefined : undefined,
    installedDirName: typeof raw.installedDirName === 'string'
      ? raw.installedDirName.trim() || undefined
      : undefined,
    harnesses: harnesses.length > 0 ? harnesses : [...ALL_HARNESSES],
    recommended: raw.recommended === true,
    setupNotes: typeof raw.setupNotes === 'string' ? raw.setupNotes.trim() || undefined : undefined,
  }
}
