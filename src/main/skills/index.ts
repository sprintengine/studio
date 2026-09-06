// The skills service: sources in, skills out, installs into the workspace.
//
// This is the one module the IPC layer talks to. Later work (Sync, Discover)
// adds handlers inside these modules rather than widening the global IPC
// registration, so `register-core-ipc.ts` and `preload/index.ts` are wired once
// and left alone.

import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  BUILTIN_SKILL_SOURCE_ID,
  CONNECTORS_SKILL_SOURCE_ID,
  LOCAL_SKILL_SOURCE_ID_PREFIX,
  localSourceFolderName,
  parseSkillFrontmatter,
  pluginAliases,
  scanPluginRenames,
  scanPlugins,
  SKILL_ENTRY_FILE,
  skillSourceMonogram,
  type ScanResult,
  type ScannedPlugin,
  type ScannedSkill,
  type SkillFileRef,
  type SkillHarness,
  type SkillSource,
} from '../../shared/skills'
import type {
  SkillAddLocalSourceInput,
  SkillAddSourceInput,
  SkillAddSourceResult,
  SkillInstallInput,
  SkillInstallOutcome,
  SkillInstalledPluginsInput,
  SkillInstalledPluginsOutcome,
  SkillPluginInstallInput,
  SkillPluginInstallOutcome,
  SkillPluginScanLinkedInput,
  SkillPluginScanLinkedOutcome,
  SkillPluginUninstallInput,
  SkillPluginUninstallOutcome,
  SkillPopularReposOutcome,
  SkillReadFileInput,
  SkillReadFileResult,
  SkillRemoveSourceInput,
  SkillRemoveSourceResult,
  SkillScanInput,
  SkillScanOutcome,
  SkillSearchInput,
  SkillSearchOutcome,
  SkillSourceUpdateCheck,
  SkillSourcesResult,
  SkillSyncSourceInput,
  SkillSyncSourceOutcome,
  SkillUninstallInput,
  SkillUninstallOutcome,
} from '../../shared/electron-api'
import {
  MARKETPLACE_EXTRA_HOSTS_ENV,
  parseMarketplaceExtraHosts,
} from '../../shared/marketplace/source-policy'
import { SKILL_PACK_HARNESSES } from '../../shared/skill-harnesses'
import { findMarketplaceResourcePath } from '../marketplace/resources'
import { resolveInstalledSkillHarnesses } from '../marketplace/skill-harness-targets'
import { adoptLegacySkillPackSources } from './adopt-legacy-packs'
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
import { installSkill, uninstallSkill } from './install'
import { installPlugin, readEnabledClaudePlugins, uninstallPlugin } from './install-plugin'
import { scanLocalSkillSource } from './local-source'
import { createPluginInstallStore, type PluginInstallStore } from './plugin-install-store'
import { scanSkillTree, SKILL_MARKETPLACE_MANIFEST_PATH } from './scan'
import {
  dedupeScannedMcpServers,
  followLinkedPlugins,
  linkedRepositoryBudget,
  LinkedPluginReadError,
  readPluginComponents,
  scanPluginTree,
  type LinkedPluginRepoReader,
} from './scan-plugins'
import { createSkillSourceStore, isRemovableSkillSource, type SkillSourceStore } from './source-store'
import { createSourceUpdateChecker } from './source-updates'
import { diffScannedSkills, installedSkillCopies, refreshInstalledSkills, refreshSourceMcpServers } from './sync'

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
  listHarnesses?: () => Promise<SkillHarness[]>
  /** Open project roots, used once to adopt the retired skill packs as sources. */
  listWorkspaceRoots?: () => string[]
  github?: SkillGithubOptions
  discovery?: SkillDiscoveryOptions
  /** CLI ids the MCP servers a plugin ships are written for; defaults to the normaliser's own. */
  mcpClients?: () => Promise<string[]>
  pluginInstallStore?: PluginInstallStore
  /** Where a check's result goes besides the caller — every window, in production. */
  broadcastSourceUpdates?: (check: SkillSourceUpdateCheck) => void
}

export type SkillsService = {
  listSources(): Promise<SkillSourcesResult>
  addSource(input: SkillAddSourceInput): Promise<SkillAddSourceResult>
  addLocalSource(input: SkillAddLocalSourceInput): Promise<SkillAddSourceResult>
  removeSource(input: SkillRemoveSourceInput): Promise<SkillRemoveSourceResult>
  getScan(input: SkillScanInput): Promise<SkillScanOutcome>
  readFile(input: SkillReadFileInput): Promise<SkillReadFileResult>
  install(input: SkillInstallInput): Promise<SkillInstallOutcome>
  uninstall(input: SkillUninstallInput): Promise<SkillUninstallOutcome>
  syncSource(input: SkillSyncSourceInput): Promise<SkillSyncSourceOutcome>
  search(input: SkillSearchInput): Promise<SkillSearchOutcome>
  listPopularRepos(): Promise<SkillPopularReposOutcome>
  scanLinkedPlugin(input: SkillPluginScanLinkedInput): Promise<SkillPluginScanLinkedOutcome>
  installPlugin(input: SkillPluginInstallInput): Promise<SkillPluginInstallOutcome>
  uninstallPlugin(input: SkillPluginUninstallInput): Promise<SkillPluginUninstallOutcome>
  listInstalledPlugins(input: SkillInstalledPluginsInput): Promise<SkillInstalledPluginsOutcome>
  /** The hourly update check (source-updates.ts), also run on demand. Broadcasts its result. */
  checkSourceUpdates(): Promise<SkillSourceUpdateCheck>
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
  const installs = deps.pluginInstallStore ?? createPluginInstallStore(userDataDir)
  const mcpClients = deps.mcpClients ?? (async () => ['claude-code', 'codex'])
  const updateChecker = createSourceUpdateChecker({
    store,
    resolveToken: deps.resolveToken,
    github: deps.github,
  })

  const localRootFor = (id: string): string | null =>
    id === BUILTIN_SKILL_SOURCE_ID
      ? builtinRoot()
      : id === CONNECTORS_SKILL_SOURCE_ID
        ? connectorRoot()
        : id.startsWith(LOCAL_SKILL_SOURCE_ID_PREFIX)
          ? id.slice(LOCAL_SKILL_SOURCE_ID_PREFIX.length)
          : null

  async function scanFor(sourceId: string): Promise<ScanResult | null> {
    if (sourceId === BUILTIN_SKILL_SOURCE_ID || sourceId === CONNECTORS_SKILL_SOURCE_ID) {
      const cached = localScans.get(sourceId)
      if (cached) return cached
      const root = localRootFor(sourceId)
      if (!root || !existsSync(root)) return null
      // Bundled, so uncapped: see scanLocalSkillSource.
      const scanned = await scanLocalSkillSource(root, { maxEntries: Number.POSITIVE_INFINITY })
      localScans.set(sourceId, scanned)
      return scanned
    }
    return store.getScan(sourceId)
  }

  return {
    /**
     * The source list, and the one place the retired skill packs are adopted:
     * this is the first call the surface makes, and adoption has to have run
     * before the list it returns is rendered.
     */
    async listSources() {
      await adoptLegacySkillPackSources({
        store,
        workspaceRoots: deps.listWorkspaceRoots?.() ?? [],
      }).catch(() => [])
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
        // Re-adding a repository already in the list carries its cached scan
        // in, so the linked plugins it already read are not read again.
        const { source, scan } = await scanGithubSource(ref, id, github, await store.getScan(id))
        await store.putSource(source, scan)
        return { ok: true, source, scan }
      } catch (error) {
        return { ok: false, message: describeFetchError(error) }
      }
    },

    /**
     * A folder on this machine as a source. It scans with the same rule a
     * repository does — walk to SKILL.md, take the directory whole — over a
     * filesystem listing instead of a git tree, which is exactly what the two
     * bundled sources already do. It carries no commit, so nothing about it
     * can claim an update is available and Sync re-reads the folder rather
     * than fetching anything.
     */
    async addLocalSource(input) {
      const path = input.path?.trim() ?? ''
      if (!path) return { ok: false, message: 'Choose a folder to add as a source.' }
      // A file passes existsSync and then scans as a folder holding nothing, so
      // the honest answer to "this is not a folder" would have been "No skills
      // here" — a source that reads as empty rather than as refused.
      let entry
      try {
        entry = statSync(path)
      } catch {
        return { ok: false, message: `${path} does not exist.` }
      }
      if (!entry.isDirectory()) return { ok: false, message: 'That is a file, not a folder.' }
      const id = `${LOCAL_SKILL_SOURCE_ID_PREFIX}${path}`
      // Re-adding a folder already in the list re-scans it, which is what
      // someone who picks it twice means; `replace: false` is the caller that
      // wants to be told instead.
      if (input.replace !== true && (await store.getSource(id))) {
        return { ok: false, message: `${path} is already one of your sources.` }
      }
      try {
        const scan = await scanLocalSkillSource(path)
        const name = localSourceFolderName(path)
        const source: SkillSource = {
          id,
          kind: 'local',
          name,
          repo: '',
          path,
          monogram: skillSourceMonogram(name),
          blurb: path,
          commitSha: '',
          scannedAt: new Date().toISOString(),
        }
        await store.putSource(source, scan)
        return { ok: true, source, scan }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
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

    /**
     * A source's skills, from its cached scan.
     *
     * A repository source with no cached scan is read now rather than reported
     * as unreadable: that is the state an adopted legacy pack starts in
     * (adopt-legacy-packs.ts records the repository without claiming to know
     * what it holds), and "open it and it lists" is what the user expects of a
     * source in their list. A read that fails says why, and Try again retries
     * the read itself.
     */
    async getScan(input) {
      const source = await store.getSource(input.sourceId ?? '')
      if (!source) return { ok: false, message: 'That source is not in your list.' }
      const scan = await scanFor(source.id)
      if (scan) return { ok: true, source, scan }
      if (source.kind === 'local') {
        const root = localRootFor(source.id)
        if (!root || !existsSync(root)) {
          return { ok: false, message: `${source.path ?? source.name} is no longer on this machine.` }
        }
        try {
          const rescanned = await scanLocalSkillSource(root)
          await store.putSource(source, rescanned)
          return { ok: true, source, scan: rescanned }
        } catch (error) {
          // A folder that outgrew the walk's cap since it was added: the reason
          // is the reader's to see, not a rejected IPC call.
          return { ok: false, message: error instanceof Error ? error.message : String(error) }
        }
      }
      if (source.kind !== 'github') {
        return { ok: false, message: `${source.name} is not available in this build.` }
      }
      const ref = parseSkillRepoRef(source.repo)
      if (!ref) return { ok: false, message: `${source.repo} is not a repository that can be read.` }
      try {
        const github = { ...deps.github, token: await deps.resolveToken() }
        const scanned = await scanGithubSource(ref, source.id, github, await store.getScan(source.id))
        await store.putSource(scanned.source, scanned.scan)
        return { ok: true, source: scanned.source, scan: scanned.scan }
      } catch (error) {
        return { ok: false, message: describeFetchError(error) }
      }
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
        provenance: {
          sourceId: located.source.id,
          skillId: located.skill.id,
          commitSha: located.source.commitSha,
        },
      })
      return result
    },

    /**
     * Removal sweeps every harness dir, not only the ones this machine reads
     * today: a skill installed while another CLI was present still has a copy
     * there, and leaving it behind means an agent keeps reading a skill the
     * user removed.
     */
    async uninstall(input) {
      const workspaceRoot = input.workspaceRoot?.trim() ?? ''
      if (!workspaceRoot || !existsSync(workspaceRoot)) {
        return { ok: false, message: 'That workspace folder no longer exists.' }
      }
      const result = await uninstallSkill({
        workspaceRoot,
        dirName: input.dirName ?? '',
        harnesses: SKILL_PACK_HARNESSES,
      })
      // A row whose skill is already gone is a stale row, and saying so beats
      // reporting a removal that removed nothing.
      if (result.ok && result.removedPaths.length === 0) {
        return { ok: false, message: `${result.dirName} is not installed in this workspace.` }
      }
      return result
    },

    /**
     * Re-read a source at its current head, replace its cached scan, and copy
     * out of the new one the skills this workspace holds *from this source* —
     * a directory installed from somewhere else keeps its bytes.
     *
     * The store is written only once the whole scan succeeded, so a failed sync
     * leaves the list exactly as it was rather than half-refreshed with a
     * timestamp that says otherwise.
     */
    async syncSource(input) {
      const source = await store.getSource(input.sourceId ?? '')
      if (!source) return { ok: false, message: 'That source is not in your list.' }
      if (source.kind === 'local') return syncLocalSource(source, input)
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
        // `previous` is the cache the follow reads: a linked plugin whose pinned
        // sha has not moved is carried over instead of fetched again, which is
        // what makes the second Sync of a marketplace cost a fraction of the
        // first and what lets a budgeted pass resume where it stopped.
        rescan = await scanGithubSource(ref, source.id, github, previous)
        // Synced to head: the head the last check recorded IS this commit now,
        // so the drift mark clears with the scan rather than an hour later.
        rescan.source = { ...rescan.source, headSha: rescan.source.commitSha, headCheckedAt: new Date().toISOString() }
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
              sourceId: source.id,
              scan: rescan.scan,
              installedCopies: await installedSkillCopies(workspaceRoot),
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
        // The servers this source installed, re-read at the same commit as the
        // skills. Independent of the workspace: MCP settings are app-level, so
        // a sync with no workspace open still refreshes them.
        mcpServers: refreshSourceMcpServers({
          sourceId: source.id,
          servers: input.mcpServers ?? [],
          scan: rescan.scan,
          commitSha: rescan.scan.commitSha,
        }),
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

    scanLinkedPlugin: scanLinkedPluginNow,
    installPlugin: installPluginNow,
    uninstallPlugin: uninstallPluginNow,
    listInstalledPlugins: listInstalledPluginsNow,

    async checkSourceUpdates() {
      const check = await updateChecker.check()
      deps.broadcastSourceUpdates?.(check)
      return check
    },
  }

  /**
   * Sync a folder source: read the folder again and refresh what this
   * workspace installed from it. Nothing is fetched, so the only failure is a
   * folder that has gone away — and that is reported rather than left as a
   * list wearing a fresh timestamp for bytes nobody re-read.
   */
  async function syncLocalSource(source: SkillSource, input: SkillSyncSourceInput): Promise<SkillSyncSourceOutcome> {
    const root = localRootFor(source.id)
    if (!root || !existsSync(root)) {
      return { ok: false, message: `${source.path ?? source.name} is no longer on this machine.` }
    }
    const previous = await store.getScan(source.id)
    let scan: ScanResult
    try {
      scan = await scanLocalSkillSource(root)
    } catch (error) {
      // A failed sync leaves the list exactly as it was and says why, the same
      // rule the repository path follows.
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
    const synced: SkillSource = { ...source, scannedAt: new Date().toISOString() }
    await store.putSource(synced, scan)
    const changes = diffScannedSkills(previous, scan)
    const workspaceRoot = (input.workspaceRoot ?? '').trim()
    const copied =
      workspaceRoot && existsSync(workspaceRoot)
        ? await refreshInstalledSkills({
            workspaceRoot,
            sourceId: source.id,
            scan,
            installedCopies: await installedSkillCopies(workspaceRoot),
            readFile: (skill, file) => readSkillBytes(synced, skill, file),
          })
        : { refreshed: [], failures: [] }
    return {
      ok: true,
      source: synced,
      scan,
      added: changes.added.length,
      removed: changes.removed.length,
      refreshed: copied.refreshed.length,
      failures: copied.failures,
      mcpServers: refreshSourceMcpServers({
        sourceId: source.id,
        servers: input.mcpServers ?? [],
        scan,
        commitSha: scan.commitSha,
      }),
    }
  }

  /**
   * A linked plugin lives in another repository, and is read when opened:
   * that repository's tree at the commit the marketplace pinned (or its head
   * when it pinned none), the plugin's directory in it, and its skills. The
   * result is written back into the source's scan so the read happens once.
   */
  async function scanLinkedPluginNow(input: SkillPluginScanLinkedInput): Promise<SkillPluginScanLinkedOutcome> {
    const source = await store.getSource(input.sourceId ?? '')
    if (!source) return { ok: false, message: 'That source is not in your list.' }
    const scan = await scanFor(source.id)
    const plugin = scanPlugins(scan ?? { plugins: [] }).find((candidate) => candidate.id === input.pluginId)
    if (!scan || !plugin) return { ok: false, message: 'That plugin is not in this source.' }
    if (plugin.origin.kind !== 'linked') return { ok: true, source, scan, plugin }
    if (plugin.origin.repo === '') {
      return { ok: false, message: `${plugin.name} is hosted outside GitHub (${plugin.origin.url}), which this app cannot read.` }
    }
    const [owner, repo] = plugin.origin.repo.split('/')
    const ref: SkillRepoRef = { owner, repo, ref: plugin.origin.ref }
    try {
      const github = { ...deps.github, token: await deps.resolveToken() }
      const commitSha = plugin.origin.sha || (await resolveSkillRepoCommit(ref, github))
      const tree = await fetchSkillRepoTree(ref, commitSha, github)
      const skillScan = scanSkillTree({ entries: tree.entries, commitSha })
      const dir = plugin.origin.path
      const inDir = skillScan.skills.filter(
        (skill) => dir === '' || skill.id === dir || skill.id.startsWith(`${dir}/`)
      )
      // `all`, because these ARE the plugin's components rather than a source's
      // skill listing: dropping one here would shrink a plugin's declared
      // contents with nothing on screen to say why.
      const { all: skills } = await enrichSkills(inDir, (skill) =>
        fetchSkillRepoFile(ref, commitSha, joinRepoPath(skill.id, SKILL_ENTRY_FILE), github).then((bytes) =>
          bytes.toString('utf8')
        )
      )
      const read = await readPluginComponents({
        dir,
        entries: tree.entries,
        skills,
        readFile: (path) =>
          fetchSkillRepoFile(ref, commitSha, path, github)
            .then((bytes) => bytes.toString('utf8'))
            .catch(() => null),
      })
      const updated: ScannedPlugin = {
        ...plugin,
        version: plugin.version || read.manifest?.version || '',
        description: plugin.description || read.manifest?.description || '',
        author: plugin.author || read.manifest?.author || '',
        homepage: plugin.homepage || read.manifest?.homepage || '',
        origin: { ...plugin.origin, sha: commitSha },
        componentsKnown: true,
        // Opening a plugin is a full read of its one repository, entry
        // documents included, so it supersedes whatever the scan's budgeted
        // follow left behind — including a `pending` or `unreadable` verdict
        // this read has just disproved (linked-plugins ruling, 2026-09-06).
        linkedRead: { status: 'read' },
        components: {
          ...read.components,
          mcpServers: read.components.mcpServers.map((server) => ({ ...server, declaredBy: plugin.id })),
        },
      }
      const nextScan: ScanResult = {
        ...scan,
        plugins: scanPlugins(scan).map((candidate) => (candidate.id === plugin.id ? updated : candidate)),
      }
      await store.putSource(source, nextScan)
      return { ok: true, source, scan: nextScan, plugin: updated }
    } catch (error) {
      return { ok: false, message: describeFetchError(error) }
    }
  }

  async function installPluginNow(input: SkillPluginInstallInput): Promise<SkillPluginInstallOutcome> {
    const workspaceRoot = input.workspaceRoot?.trim() ?? ''
    if (!workspaceRoot) {
      return { ok: false, message: 'Open a workspace to install a plugin — plugins install into a workspace, not the app.' }
    }
    if (!existsSync(workspaceRoot)) return { ok: false, message: 'That workspace folder no longer exists.' }
    const source = await store.getSource(input.sourceId ?? '')
    if (!source) return { ok: false, message: 'That source is not in your list.' }
    let scan = await scanFor(source.id)
    let plugin = scanPlugins(scan ?? { plugins: [] }).find((candidate) => candidate.id === input.pluginId)
    if (!scan || !plugin) return { ok: false, message: 'That plugin is not in this source.' }
    if (!plugin.componentsKnown) {
      const read = await scanLinkedPluginNow({ sourceId: source.id, pluginId: plugin.id })
      if (!read.ok) return read
      scan = read.scan
      plugin = read.plugin
    }
    if (plugin.components.hooks.length > 0 && input.acknowledgedHooks !== true) {
      return {
        ok: false,
        needsHookAcknowledgement: true,
        message: `${plugin.name} runs ${plugin.components.hooks.length} hook command${plugin.components.hooks.length === 1 ? '' : 's'} on your machine. Review them, then install.`,
      }
    }
    const origin = plugin.origin
    const commitSha = origin.kind === 'linked' ? origin.sha : source.commitSha
    const bytesRef: SkillRepoRef | null =
      origin.kind === 'linked'
        ? { owner: origin.repo.split('/')[0] ?? '', repo: origin.repo.split('/')[1] ?? '', ref: '' }
        : source.kind === 'github'
          ? githubRefFor(source)
          : null
    const harnesses = await listHarnesses()
    const result = await installPlugin({
      workspaceRoot,
      sourceId: source.id,
      marketplaceName: scan.marketplaceName ?? '',
      marketplaceRepo: source.kind === 'github' ? source.repo : '',
      plugin,
      harnesses,
      commitSha,
      readSkillFile: async (skill, file) => {
        if (bytesRef) {
          const github = { ...deps.github, token: await deps.resolveToken() }
          return fetchSkillRepoFile(bytesRef, commitSha, joinRepoPath(skill.id, file.path), github)
        }
        return readSkillBytes(source, skill, file)
      },
      mcpClients: await mcpClients(),
    })
    if (!result.ok) return result
    await installs.put({
      workspaceRoot,
      sourceId: source.id,
      pluginId: plugin.id,
      pluginName: plugin.name,
      marketplaceName: scan.marketplaceName ?? '',
      claudePluginKey: result.claudePluginKey,
      skillDirNames: [...new Set(result.harnesses.flatMap((harness) => harness.skillDirNames))],
      mcpServerIds: result.mcpServers.map((server) => server.id),
      commitSha,
      installedAt: new Date().toISOString(),
    })
    // The receipt just written names the plugin as the marketplace lists it
    // NOW. A receipt under a name it was renamed from is the same install, and
    // leaving it beside the new one lists the plugin twice under Installed and
    // leaves an uninstall that removes only half of it.
    for (const alias of pluginAliases(scanPluginRenames(scan), plugin.id)) {
      if (alias !== plugin.id) await installs.remove(workspaceRoot, source.id, alias)
    }
    return {
      ok: true,
      plugin,
      harnesses: result.harnesses,
      mcpServers: result.mcpServers,
      claudePluginKey: result.claudePluginKey,
      warnings: result.warnings,
    }
  }

  async function uninstallPluginNow(input: SkillPluginUninstallInput): Promise<SkillPluginUninstallOutcome> {
    const workspaceRoot = input.workspaceRoot?.trim() ?? ''
    if (!workspaceRoot || !existsSync(workspaceRoot)) {
      return { ok: false, message: 'That workspace folder no longer exists.' }
    }
    const record = await installs.get(workspaceRoot, input.sourceId ?? '', input.pluginId ?? '')
    if (!record) return { ok: false, message: 'That plugin is not installed in this workspace.' }
    const result = await uninstallPlugin({
      workspaceRoot,
      pluginId: record.pluginId,
      marketplaceName: record.marketplaceName,
      skillDirNames: record.skillDirNames,
      allHarnesses: SKILL_PACK_HARNESSES,
    })
    if (!result.ok) return result
    await installs.remove(workspaceRoot, record.sourceId, record.pluginId)
    return { ...result, mcpServerIds: record.mcpServerIds }
  }

  /**
   * What is installed, from two places: the receipts this app wrote, and the
   * plugins the workspace's Claude settings enable — a plugin enabled by hand
   * with `/plugin install` is installed too, and listing only our own writes
   * would offer to install it again.
   */
  async function listInstalledPluginsNow(input: SkillInstalledPluginsInput): Promise<SkillInstalledPluginsOutcome> {
    const workspaceRoot = input.workspaceRoot?.trim() ?? ''
    if (!workspaceRoot) return { ok: true, plugins: [] }
    const recorded = await installs.list(workspaceRoot)
    const known = new Set(recorded.map((record) => record.claudePluginKey).filter((key) => key !== ''))
    const enabled = await readEnabledClaudePlugins(workspaceRoot)
    const foreign = [...enabled]
      .filter((key) => !known.has(key))
      .map((key): InstalledPluginRecordShape => {
        const at = key.lastIndexOf('@')
        return {
          workspaceRoot,
          sourceId: '',
          pluginId: at === -1 ? key : key.slice(0, at),
          pluginName: at === -1 ? key : key.slice(0, at),
          marketplaceName: at === -1 ? '' : key.slice(at + 1),
          claudePluginKey: key,
          skillDirNames: [],
          mcpServerIds: [],
          commitSha: '',
          installedAt: '',
        }
      })
    return { ok: true, plugins: [...recorded, ...foreign] }
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
  github: SkillGithubOptions,
  /**
   * This source's previous scan, when there is one. A linked plugin whose
   * pinned sha has not moved is taken from it, so a re-scan reads only what
   * moved (linked-plugins ruling, 2026-09-06).
   */
  previous?: ScanResult | null
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
  const { all, skills, skippedNoDescription } = await enrichSkills(scanned.skills, (skill) =>
    fetchSkillRepoFile(ref, commitSha, joinRepoPath(skill.id, SKILL_ENTRY_FILE), github).then((bytes) =>
      bytes.toString('utf8')
    )
  )
  // The plugins and MCP servers the same tree declares. Their manifests are a
  // handful of small raw reads at the pinned commit; one that fails leaves its
  // plugin listed under the marketplace's own words.
  const plugins = await scanPluginTree({
    entries: tree.entries,
    // Every directory, not just the listable ones: a plugin's own manifest is
    // the authority on what that plugin ships, and a skill this scan will not
    // list is still a directory the plugin shipped.
    skills: all,
    marketplaceManifest: manifest,
    readFile: (path) =>
      fetchSkillRepoFile(ref, commitSha, path, github)
        .then((bytes) => bytes.toString('utf8'))
        .catch(() => null),
  })
  // …and the plugins that live in OTHER repositories, read at the commits this
  // marketplace pinned (linked-plugins ruling, 2026-09-06). One tree listing
  // per distinct repository, bounded by a budget the token decides, and every
  // plugin a previous scan already read at the same sha costs nothing at all.
  const followed = await followLinkedPlugins({
    plugins: plugins.plugins,
    cached: previous ? scanPlugins(previous) : [],
    marketplaceManifest: manifest,
    budget: linkedRepositoryBudget(github.token),
    extraHosts: parseMarketplaceExtraHosts(process.env[MARKETPLACE_EXTRA_HOSTS_ENV]),
    reader: githubLinkedPluginReader(github),
  })
  // `fileCount` is recounted because a skipped skill takes its files with it.
  const scan: ScanResult = {
    ...scanned,
    skills,
    skippedNoDescription,
    fileCount: skills.reduce((total, skill) => total + skill.files.length, 0),
    ...plugins,
    plugins: followed.plugins,
    // The source's server list is the reach of everything it lists, in-tree and
    // linked alike: 15 was the in-tree count, and it was not what this
    // repository actually offers.
    mcpServers: dedupeScannedMcpServers([...plugins.mcpServers, ...followed.mcpServers]),
  }

  const name = `${ref.owner}/${ref.repo}`
  return {
    source: {
      id,
      kind: 'github',
      name: ref.repo,
      repo: name,
      monogram: skillSourceMonogram(ref.repo),
      blurb: describeSourceBlurb(name, skills.length, scan.plugins?.length ?? 0, scan.mcpServers?.length ?? 0),
      commitSha,
      scannedAt: new Date().toISOString(),
    },
    scan,
  }
}

/**
 * `followLinkedPlugins`'s reader, over GitHub.
 *
 * Its whole job besides fetching is to sort failures into "this minute" and
 * "this repository", because the follow stops the entire pass on the first of
 * the former and carries on past the latter. 403 and 429 are how GitHub says
 * rate limit (`githubErrorMessage` in github-tree.ts). A `SkillFetchError`
 * carrying NO status code is a request that never reached GitHub at all — the
 * machine is offline, DNS failed, the fetch timed out — and calling that
 * "unreadable" would tell somebody on a train that 238 repositories are gone.
 */
function githubLinkedPluginReader(github: SkillGithubOptions): LinkedPluginRepoReader {
  const refFor = (repo: string): SkillRepoRef => {
    const [owner, name] = repo.split('/')
    return { owner: owner ?? '', repo: name ?? '', ref: '' }
  }
  const rethrow = (error: unknown): never => {
    throw new LinkedPluginReadError(describeFetchError(error), linkedFailureKind(error))
  }
  return {
    resolveCommit: (repo, ref) =>
      resolveSkillRepoCommit({ ...refFor(repo), ref }, github).catch(rethrow),
    readTree: (repo, sha) =>
      fetchSkillRepoTree(refFor(repo), sha, github)
        .then((tree) => tree.entries)
        .catch(rethrow),
    // A missing file is null, not a failure: `.mcp.json` and `hooks/hooks.json`
    // are absent from most plugins, and the tree listing has already said which
    // of them exist. A rate limit reaching HERE cannot stop the pass — the tree
    // is already in hand — so it only costs this plugin that one file.
    //
    // Which is exactly why it is tried twice. The scan only asks for a path the
    // tree listed, so a null is a fetch that failed rather than a file that is
    // not there, and the plugin then lists fewer components than it ships with
    // nothing on screen to say so. A run of the live marketplace on 2026-09-06
    // lost seven MCP servers that way — 172 where two other runs read 179 —
    // out of 386 raw reads. One retry, because a second failure on the same
    // byte range is no longer plausibly a blip.
    readFile: async (repo, sha, path) => {
      const read = (): Promise<string | null> =>
        fetchSkillRepoFile(refFor(repo), sha, path, github).then((bytes) => bytes.toString('utf8'))
      return read().catch(() => read().catch(() => null))
    },
  }
}

/**
 * Fill in each skill's frontmatter — name, description, declared tools, and the
 * optional license, compatibility and metadata the Agent Skills specification
 * defines — from its entry document. A skill whose entry cannot be read keeps
 * its directory name and an empty description — an honest blank, never invented
 * copy.
 *
 * An entry that WAS read and declares no `description` is not a skill at all
 * (https://agentskills.io/specification, fetched 2026-09-06), so it is left out
 * of `skills` and counted. "Read" is the load-bearing word: an entry the reader
 * could not fetch, or that sat past `MAX_ENRICHED_SKILLS`, was never seen, and
 * nothing is dropped for a document nobody read. A zero-byte SKILL.md IS read,
 * and declares no description.
 *
 * `all` carries every directory the tree held, enriched, skipped ones included.
 * The plugin scan matches its manifests against that list: a plugin naming a
 * directory that shipped and was read must not be told the directory is
 * missing, which is what handing it the filtered list did.
 */
async function enrichSkills(
  skills: readonly ScannedSkill[],
  readEntry: (skill: ScannedSkill) => Promise<string | null>
): Promise<{ all: ScannedSkill[]; skills: ScannedSkill[]; skippedNoDescription: number }> {
  const enriched = [...skills]
  const skipped = new Set<number>()
  let cursor = 0
  const workers = Array.from({ length: Math.min(ENRICHMENT_CONCURRENCY, enriched.length) }, async () => {
    while (cursor < enriched.length && cursor < MAX_ENRICHED_SKILLS) {
      const index = cursor
      cursor += 1
      // null is "not read"; '' is a document that exists and says nothing.
      const raw = await readEntry(enriched[index]).catch(() => null)
      if (raw === null) continue
      const frontmatter = parseSkillFrontmatter(raw)
      if (frontmatter.description === '') {
        skipped.add(index)
        continue
      }
      enriched[index] = {
        ...enriched[index],
        name: frontmatter.name || enriched[index].name,
        description: frontmatter.description,
        allowedTools: frontmatter.allowedTools,
        license: frontmatter.license,
        compatibility: frontmatter.compatibility,
        metadata: frontmatter.metadata,
      }
    }
  })
  await Promise.all(workers)
  return {
    all: enriched,
    skills: enriched.filter((_, index) => !skipped.has(index)),
    skippedNoDescription: skipped.size,
  }
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

/** Which of the three a GitHub failure is — see `githubLinkedPluginReader`. */
function linkedFailureKind(error: unknown): 'rate-limited' | 'offline' | 'unreadable' {
  if (!(error instanceof SkillFetchError)) return 'unreadable'
  if (error.statusCode === 403 || error.statusCode === 429) return 'rate-limited'
  return error.statusCode === undefined ? 'offline' : 'unreadable'
}

function describeFetchError(error: unknown): string {
  if (error instanceof SkillFetchError) return error.message
  return error instanceof Error ? error.message : String(error)
}

type InstalledPluginRecordShape = import('../../shared/electron-api').InstalledPluginRecord

function describeSourceBlurb(name: string, skills: number, plugins: number, servers: number): string {
  const parts: string[] = []
  if (plugins > 0) parts.push(`${plugins} ${plugins === 1 ? 'plugin' : 'plugins'}`)
  if (servers > 0) parts.push(`${servers} MCP ${servers === 1 ? 'server' : 'servers'}`)
  if (skills > 0) parts.push(`${skills} ${skills === 1 ? 'skill' : 'skills'}`)
  return parts.length > 0 ? `${parts.join(', ')} from ${name}.` : `Nothing installable found in ${name}.`
}
