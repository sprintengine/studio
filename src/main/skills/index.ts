// The skills service: sources in, skills out, installs into the workspace.
//
// This is the one module the IPC layer talks to. Later work (Sync, Discover)
// adds handlers inside these modules rather than widening the global IPC
// registration, so `register-core-ipc.ts` and `preload/index.ts` are wired once
// and left alone.

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SkillPackHarness } from '../../shared/electron-api'
import {
  BUILTIN_SKILL_SOURCE_ID,
  CONNECTORS_SKILL_SOURCE_ID,
  parseSkillFrontmatter,
  SKILL_ENTRY_FILE,
  skillSourceMonogram,
  type ScanResult,
  type ScannedSkill,
  type SkillFileRef,
  type SkillSource,
} from '../../shared/skills'
import type {
  SkillAddSourceInput,
  SkillAddSourceResult,
  SkillInstallInput,
  SkillInstallOutcome,
  SkillPopularReposOutcome,
  SkillReadFileInput,
  SkillReadFileResult,
  SkillRemoveSourceInput,
  SkillRemoveSourceResult,
  SkillScanInput,
  SkillScanOutcome,
  SkillSearchInput,
  SkillSearchOutcome,
  SkillSourcesResult,
  SkillSyncSourceInput,
  SkillSyncSourceOutcome,
} from '../../shared/electron-api'
import { findMarketplaceResourcePath } from '../marketplace/resources'
import { resolveInstalledSkillHarnesses } from '../marketplace/skill-harness-targets'
import { createSkillDiscoveryClient, type SkillDiscoveryOptions } from './discover'
import {
  fetchSkillRepoFile,
  fetchSkillRepoTree,
  parseSkillRepoRef,
  resolveSkillRepoCommit,
  SkillFetchError,
  type SkillGithubOptions,
  type SkillRepoRef,
} from './github-tree'
import { installSkill } from './install'
import { scanLocalSkillSource } from './local-source'
import { scanSkillTree, SKILL_MARKETPLACE_MANIFEST_PATH } from './scan'
import { createSkillSourceStore, isRemovableSkillSource, type SkillSourceStore } from './source-store'
import { diffScannedSkills, installedSkillHarnesses, refreshInstalledSkills } from './sync'

// How many entry documents a scan reads to fill in names and descriptions. The
// listing is what makes a source browsable, so this runs at scan time and the
// result is cached; beyond the cap a skill keeps its directory name rather than
// the scan turning into thousands of requests.
const MAX_ENRICHED_SKILLS = 400
const ENRICHMENT_CONCURRENCY = 8

export type SkillsServiceDeps = {
  resolveToken: () => Promise<string>
  /** Overridden in tests; production reads the packaged resource dirs. */
  builtinSkillsRoot?: () => string | null
  connectorSkillsRoot?: () => string | null
  listHarnesses?: () => Promise<SkillPackHarness[]>
  github?: SkillGithubOptions
  discovery?: SkillDiscoveryOptions
}

export type SkillsService = {
  listSources(): Promise<SkillSourcesResult>
  addSource(input: SkillAddSourceInput): Promise<SkillAddSourceResult>
  removeSource(input: SkillRemoveSourceInput): Promise<SkillRemoveSourceResult>
  getScan(input: SkillScanInput): Promise<SkillScanOutcome>
  readFile(input: SkillReadFileInput): Promise<SkillReadFileResult>
  install(input: SkillInstallInput): Promise<SkillInstallOutcome>
  syncSource(input: SkillSyncSourceInput): Promise<SkillSyncSourceOutcome>
  search(input: SkillSearchInput): Promise<SkillSearchOutcome>
  listPopularRepos(): Promise<SkillPopularReposOutcome>
}

export function createSkillsService(
  userDataDir: string,
  deps: SkillsServiceDeps,
  store: SkillSourceStore = createSkillSourceStore(userDataDir)
): SkillsService {
  const builtinRoot = deps.builtinSkillsRoot ?? defaultBuiltinSkillsRoot
  const connectorRoot = deps.connectorSkillsRoot ?? (() => findMarketplaceResourcePath('skills'))
  const listHarnesses = deps.listHarnesses ?? (() => resolveInstalledSkillHarnesses())
  const localScans = new Map<string, ScanResult>()
  const discovery = createSkillDiscoveryClient(deps.discovery)

  const localRootFor = (id: string): string | null =>
    id === BUILTIN_SKILL_SOURCE_ID ? builtinRoot() : id === CONNECTORS_SKILL_SOURCE_ID ? connectorRoot() : null

  async function scanFor(sourceId: string): Promise<ScanResult | null> {
    if (sourceId === BUILTIN_SKILL_SOURCE_ID || sourceId === CONNECTORS_SKILL_SOURCE_ID) {
      const cached = localScans.get(sourceId)
      if (cached) return cached
      const root = localRootFor(sourceId)
      if (!root || !existsSync(root)) return null
      const scanned = await scanLocalSkillSource(root)
      localScans.set(sourceId, scanned)
      return scanned
    }
    return store.getScan(sourceId)
  }

  return {
    async listSources() {
      return { ok: true, sources: await store.listSources() }
    },

    async addSource(input) {
      const ref = parseSkillRepoRef(input.repo ?? '')
      if (!ref) {
        return {
          ok: false,
          message: 'Enter a public GitHub repository, like owner/name or its github.com address.',
        }
      }
      const id = `github:${ref.owner}/${ref.repo}`
      const existing = await store.getSource(id)
      if (existing && input.replace !== true) {
        return { ok: false, message: `${ref.owner}/${ref.repo} is already one of your sources.` }
      }
      try {
        const github = { ...deps.github, token: await deps.resolveToken() }
        const { source, scan } = await scanGithubSource(ref, id, github)
        await store.putSource(source, scan)
        return { ok: true, source, scan }
      } catch (error) {
        return { ok: false, message: describeFetchError(error) }
      }
    },

    async removeSource(input) {
      const id = input.sourceId ?? ''
      if (!isRemovableSkillSource(id)) {
        return { ok: false, message: 'This source is part of Multicode and cannot be removed.' }
      }
      const removed = await store.removeSource(id)
      return removed ? { ok: true, sourceId: id } : { ok: false, message: 'That source is not in your list.' }
    },

    async getScan(input) {
      const source = await store.getSource(input.sourceId ?? '')
      if (!source) return { ok: false, message: 'That source is not in your list.' }
      const scan = await scanFor(source.id)
      if (!scan) {
        return { ok: false, message: `${source.name} has not been scanned yet.` }
      }
      return { ok: true, source, scan }
    },

    async readFile(input) {
      const found = await resolveSkillFile(input.sourceId ?? '', input.skillId ?? '', input.path ?? '')
      if (!found.ok) return found
      try {
        const bytes = await readSkillBytes(found.source, found.skill, found.file)
        // Reading returns text. Decoding an image or archive as UTF-8 would
        // hand back convincing mojibake, so a file that is not text says so.
        if (!isUtf8Text(bytes)) {
          return { ok: false, message: `${found.file.path} is not a text file.` }
        }
        return { ok: true, path: found.file.path, content: bytes.toString('utf8') }
      } catch (error) {
        return { ok: false, message: describeFetchError(error) }
      }
    },

    async install(input) {
      const workspaceRoot = input.workspaceRoot?.trim() ?? ''
      if (!workspaceRoot) {
        return {
          ok: false,
          message: 'Open a workspace to install a skill — skills are installed into a workspace, not the app.',
        }
      }
      if (!existsSync(workspaceRoot)) {
        return { ok: false, message: 'That workspace folder no longer exists.' }
      }
      const located = await locateSkill(input.sourceId ?? '', input.skillId ?? '')
      if (!located.ok) return located
      const harnesses = await listHarnesses()
      const result = await installSkill({
        workspaceRoot,
        skill: located.skill,
        harnesses,
        readFile: (file) => readSkillBytes(located.source, located.skill, file),
      })
      return result
    },

    /**
     * Re-read a source at its current head, replace its cached scan, and copy
     * the skills this workspace already holds out of the new one.
     *
     * The store is written only once the whole scan succeeded, so a failed sync
     * leaves the list exactly as it was rather than half-refreshed with a
     * timestamp that says otherwise.
     */
    async syncSource(input) {
      const source = await store.getSource(input.sourceId ?? '')
      if (!source) return { ok: false, message: 'That source is not in your list.' }
      if (source.kind !== 'github') {
        return { ok: false, message: `${source.name} ships with Multicode and refreshes with the app.` }
      }
      const ref = parseSkillRepoRef(source.repo)
      if (!ref) {
        return { ok: false, message: `${source.repo} is not a repository that can be re-read.` }
      }

      const previous = await store.getScan(source.id)
      let rescan: { source: SkillSource; scan: ScanResult }
      try {
        const github = { ...deps.github, token: await deps.resolveToken() }
        rescan = await scanGithubSource(ref, source.id, github)
        await store.putSource(rescan.source, rescan.scan)
      } catch (error) {
        return { ok: false, message: describeFetchError(error) }
      }

      const changes = diffScannedSkills(previous, rescan.scan)
      const workspaceRoot = input.workspaceRoot?.trim() ?? ''
      // Sources are app-level and the door opens without a workspace, so a sync
      // with none refreshes the list and copies nothing — there is nowhere for
      // a skill to be installed.
      const copied =
        workspaceRoot && existsSync(workspaceRoot)
          ? await refreshInstalledSkills({
              workspaceRoot,
              scan: rescan.scan,
              installedHarnesses: await installedSkillHarnesses(workspaceRoot),
              readFile: (skill, file) => readSkillBytes(rescan.source, skill, file),
            })
          : { refreshed: [], failures: [] }

      return {
        ok: true,
        source: rescan.source,
        scan: rescan.scan,
        added: changes.added.length,
        removed: changes.removed.length,
        refreshed: copied.refreshed.length,
        failures: copied.failures,
      }
    },

    /**
     * Discover finds candidates; it does not add anything. A chosen result is
     * handed to `addSource`, which is the one path that scans a repository.
     */
    async search(input) {
      return discovery.searchSkills(input.query ?? '', await deps.resolveToken())
    },

    async listPopularRepos() {
      return discovery.listPopularSkillRepos(await deps.resolveToken())
    },
  }

  async function locateSkill(
    sourceId: string,
    skillId: string
  ): Promise<{ ok: true; source: SkillSource; skill: ScannedSkill } | { ok: false; message: string }> {
    const source = await store.getSource(sourceId)
    if (!source) return { ok: false, message: 'That source is not in your list.' }
    const scan = await scanFor(source.id)
    const skill = scan?.skills.find((candidate) => candidate.id === skillId)
    if (!skill) return { ok: false, message: 'That skill is not in this source.' }
    return { ok: true, source, skill }
  }

  async function resolveSkillFile(
    sourceId: string,
    skillId: string,
    path: string
  ): Promise<
    { ok: true; source: SkillSource; skill: ScannedSkill; file: SkillFileRef } | { ok: false; message: string }
  > {
    const located = await locateSkill(sourceId, skillId)
    if (!located.ok) return located
    // Only files the scan already listed are readable, so a crafted path can
    // never reach outside the skill.
    const file = located.skill.files.find((candidate) => candidate.path === path)
    if (!file) return { ok: false, message: 'That file is not part of this skill.' }
    return { ok: true, source: located.source, skill: located.skill, file }
  }

  async function readSkillBytes(
    source: SkillSource,
    skill: ScannedSkill,
    file: SkillFileRef
  ): Promise<Buffer> {
    if (source.kind === 'github') {
      const github = { ...deps.github, token: await deps.resolveToken() }
      return fetchSkillRepoFile(githubRefFor(source), source.commitSha, joinRepoPath(skill.id, file.path), github)
    }
    const root = localRootFor(source.id)
    if (!root) throw new SkillFetchError(`${source.name} is not available in this build.`)
    return readFile(join(root, ...skill.id.split('/').filter(Boolean), ...file.path.split('/')))
  }
}

async function scanGithubSource(
  ref: SkillRepoRef,
  id: string,
  github: SkillGithubOptions
): Promise<{ source: SkillSource; scan: ScanResult }> {
  const commitSha = await resolveSkillRepoCommit(ref, github)
  const tree = await fetchSkillRepoTree(ref, commitSha, github)
  const manifest = tree.entries.some(
    (entry) => entry.type === 'blob' && entry.path === SKILL_MARKETPLACE_MANIFEST_PATH
  )
    ? await fetchSkillRepoFile(ref, commitSha, SKILL_MARKETPLACE_MANIFEST_PATH, github)
        .then((bytes) => bytes.toString('utf8'))
        .catch(() => null)
    : null

  const scanned = scanSkillTree({ entries: tree.entries, commitSha, marketplaceManifest: manifest })
  const skills = await enrichSkills(scanned.skills, (skill) =>
    fetchSkillRepoFile(ref, commitSha, joinRepoPath(skill.id, SKILL_ENTRY_FILE), github).then((bytes) =>
      bytes.toString('utf8')
    )
  )
  const scan: ScanResult = { ...scanned, skills }

  const name = `${ref.owner}/${ref.repo}`
  return {
    source: {
      id,
      kind: 'github',
      name: ref.repo,
      repo: name,
      monogram: skillSourceMonogram(ref.repo),
      blurb: `${skills.length} ${skills.length === 1 ? 'skill' : 'skills'} from ${name}.`,
      commitSha,
      scannedAt: new Date().toISOString(),
    },
    scan,
  }
}

/**
 * Fill in each skill's name, description and declared tools from its entry
 * document. A skill whose entry cannot be read keeps its directory name and an
 * empty description — an honest blank, never invented copy.
 */
async function enrichSkills(
  skills: readonly ScannedSkill[],
  readEntry: (skill: ScannedSkill) => Promise<string>
): Promise<ScannedSkill[]> {
  const enriched = [...skills]
  let cursor = 0
  const workers = Array.from({ length: Math.min(ENRICHMENT_CONCURRENCY, enriched.length) }, async () => {
    while (cursor < enriched.length && cursor < MAX_ENRICHED_SKILLS) {
      const index = cursor
      cursor += 1
      const raw = await readEntry(enriched[index]).catch(() => '')
      if (raw === '') continue
      const frontmatter = parseSkillFrontmatter(raw)
      enriched[index] = {
        ...enriched[index],
        name: frontmatter.name || enriched[index].name,
        description: frontmatter.description,
        allowedTools: frontmatter.allowedTools,
      }
    }
  })
  await Promise.all(workers)
  return enriched
}

function githubRefFor(source: SkillSource): SkillRepoRef {
  const [owner, repo] = source.repo.split('/')
  return { owner: owner ?? '', repo: repo ?? '', ref: '' }
}

function joinRepoPath(skillId: string, relativePath: string): string {
  return skillId === '' ? relativePath : `${skillId}/${relativePath}`
}

function defaultBuiltinSkillsRoot(): string | null {
  const candidates = [
    ...(process.resourcesPath ? [join(process.resourcesPath, 'skills')] : []),
    join(process.cwd(), 'resources', 'skills'),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

/** Round-trips as UTF-8 and carries no NUL — the cheap, exact "is this text". */
function isUtf8Text(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false
  return Buffer.compare(Buffer.from(bytes.toString('utf8'), 'utf8'), bytes) === 0
}

function describeFetchError(error: unknown): string {
  if (error instanceof SkillFetchError) return error.message
  return error instanceof Error ? error.message : String(error)
}
