import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import type {
  MarketplaceComponentKind,
  MarketplaceManifestIssue,
  MarketplacePluginAuthoringManifest,
  MarketplacePluginEntry,
} from '../../shared/marketplace'
import {
  MARKETPLACE_CANONICAL_SOURCE,
  MARKETPLACE_COMPONENT_KINDS,
  MARKETPLACE_EXTRA_HOSTS_ENV,
  hasCodeBearingComponent,
  isMarketplaceSourceHostAllowed,
  parseMarketplaceExtraHosts,
  parseMarketplacePluginAuthoringManifest,
  resolveOptionallySignedManifest,
} from '../../shared/marketplace'
import { isSafeManifestRelativePath } from '../../../packages/module-sdk/src/manifest-validate'
import {
  marketplaceComponentDigestMismatchIssuesSync,
  marketplaceComponentDigestPaths,
} from '../../../packages/module-sdk/src/plugin-component-digests'
import {
  classifyModuleTrust,
  classifySignedManifestTrust,
  isLoadEligible,
  type ModuleTrust,
  type ModuleTrustContext,
} from '../modules/module-signature'
import { findMarketplaceResourcePath, type MarketplaceResourceResolver } from './resources'

export const DEFAULT_MARKETPLACE_PLUGIN_STAGING_DIR = 'marketplace-plugin-staging'
export const DEFAULT_MARKETPLACE_PLUGIN_DOWNLOAD_TIMEOUT_MS = 30_000
export const DEFAULT_MARKETPLACE_PLUGIN_MAX_FILES = 500
export const DEFAULT_MARKETPLACE_PLUGIN_MAX_FILE_BYTES = 5 * 1024 * 1024
export const DEFAULT_MARKETPLACE_PLUGIN_MAX_TOTAL_BYTES = 25 * 1024 * 1024

export type MarketplacePluginDownloadFetch = (url: string, init: RequestInit) => Promise<Response>

export type MarketplacePluginTrustClassification = 'verified' | 'community' | 'unsigned' | 'invalid'

export type MarketplacePluginDownloadOptions = {
  entry: MarketplacePluginEntry
  trustContext: ModuleTrustContext
  stagingRoot?: string
  fetcher?: MarketplacePluginDownloadFetch
  timeoutMs?: number
  maxFiles?: number
  maxFileBytes?: number
  maxTotalBytes?: number
  packagedResourceResolver?: MarketplaceResourceResolver
}

export type MarketplacePluginDownloadResult =
  | {
    ok: true
    classification: MarketplacePluginTrustClassification
    sourceUrl: string
    stagedBundlePath: string
    manifest: MarketplacePluginAuthoringManifest
    trust: ModuleTrust
    loadEligible: boolean
  }
  | {
    ok: false
    classification?: MarketplacePluginTrustClassification
    sourceUrl: string
    message: string
    statusCode?: number
    issues?: MarketplaceManifestIssue[]
    trust?: ModuleTrust
  }

type DownloadLimits = {
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
}

type GithubTreeSource = {
  owner: string
  repo: string
  ref: string
  path: string
}

type GithubContentsEntry = {
  type?: string
  path?: string
  download_url?: string | null
  url?: string
}

type DownloadState = {
  files: number
  bytes: number
  /** Contents-API directory requests issued this walk (bounds empty-dir trees). */
  dirRequests: number
}

// A hostile repo can be a tree of thousands of EMPTY directories — maxFiles
// never triggers, but every directory costs one contents-API request. Cap the
// walk itself (requests + depth) so a pre-trust preview can never be driven
// into unbounded API amplification.
const MAX_GITHUB_DIR_REQUESTS = 200
const MAX_GITHUB_DIR_DEPTH = 12
const COMMIT_SHA_REF_PATTERN = /^[a-f0-9]{40}$/

async function fetchTextForClaude(
  url: string,
  fetcher: MarketplacePluginDownloadFetch,
  timeoutMs: number | undefined,
  maxBytes: number
): Promise<string> {
  return fetchText(url, fetcher, timeoutMs, { accept: 'application/vnd.github+json' }, maxBytes)
}

export function defaultMarketplacePluginStagingRoot(userDataDir?: string): string {
  return join(userDataDir?.trim() || tmpdir(), DEFAULT_MARKETPLACE_PLUGIN_STAGING_DIR)
}

export async function downloadMarketplacePluginBundle(
  options: MarketplacePluginDownloadOptions
): Promise<MarketplacePluginDownloadResult> {
  // Bundle download requires a `source`; inline-MCP registry entries carry no
  // bundle and never reach this path, but `source` is optional on the entry type.
  if (!options.entry.source) {
    return { ok: false, sourceUrl: '', message: 'Marketplace entry has no bundle source to download.' }
  }
  const sourceUrl = options.entry.source.trim()
  const parsedSource = parseHttpsUrl(sourceUrl)
  if (!parsedSource.ok) {
    return { ok: false, sourceUrl, message: parsedSource.message }
  }

  const stagingRoot = options.stagingRoot ?? defaultMarketplacePluginStagingRoot()
  const fetcher = options.fetcher ?? defaultFetch
  const packagedResourceResolver = options.packagedResourceResolver ?? findMarketplaceResourcePath
  const limits: DownloadLimits = {
    maxFiles: options.maxFiles ?? DEFAULT_MARKETPLACE_PLUGIN_MAX_FILES,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MARKETPLACE_PLUGIN_MAX_FILE_BYTES,
    maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MARKETPLACE_PLUGIN_MAX_TOTAL_BYTES,
  }

  let stage: string | null = null
  try {
    await mkdir(stagingRoot, { recursive: true })
    stage = await mkdtemp(join(stagingRoot, `${options.entry.id}-`))
    const github = parseGithubTreeSource(parsedSource.url)
    if (github) {
      try {
        await downloadGithubTree(github, stage, fetcher, options.timeoutMs, limits)
      } catch (error) {
        if (!isPackagedSeedFallbackEligible(error, github)) throw error
        await rm(stage, { recursive: true, force: true })
        stage = await mkdtemp(join(stagingRoot, `${options.entry.id}-`))
        const copiedSeedBundle = await copyPackagedMarketplacePluginBundle(
          github,
          options.entry.id,
          stage,
          packagedResourceResolver
        )
        if (!copiedSeedBundle) throw error
      }
    } else {
      await downloadGenericPluginSource(parsedSource.url, stage, fetcher, options.timeoutMs, limits)
    }

    const manifestSource = await readFile(join(stage, 'plugin.json'), 'utf8')
    const resolved = resolveDownloadedManifest(manifestSource, options.trustContext)
    if (!resolved.ok) {
      await rm(stage, { recursive: true, force: true })
      return {
        ok: false,
        sourceUrl,
        classification: resolved.classification,
        ...(resolved.trust ? { trust: resolved.trust } : {}),
        message: resolved.message,
        issues: resolved.issues,
      }
    }

    const { manifest, trust } = resolved
    const classification = classifyMarketplaceTrust(options.entry, trust)
    // Invalid signatures never proceed, regardless of component kind.
    if (classification === 'invalid') {
      await rm(stage, { recursive: true, force: true })
      return {
        ok: false,
        sourceUrl,
        classification,
        trust,
        message: 'Downloaded plugin bundle signature is invalid.',
        issues: [{ path: 'signature', message: 'Invalid signature.' }],
      }
    }
    // Unsigned bundles are permitted only when they carry no code component: an
    // unsigned module/cli must never become load-eligible, so gate on signature
    // presence (id-trust would otherwise promote an unsigned manifest to
    // 'trusted' and slip a code component past the classification check).
    if (!manifest.signature && hasCodeBearingComponent(manifest.components)) {
      await rm(stage, { recursive: true, force: true })
      return {
        ok: false,
        sourceUrl,
        classification: 'unsigned',
        trust,
        message: 'Downloaded plugin bundle is unsigned.',
        issues: [{ path: 'signature', message: 'signature is required.' }],
      }
    }

    const mismatch = registryMismatchIssues(options.entry, manifest)
    if (mismatch.length > 0) {
      await rm(stage, { recursive: true, force: true })
      return {
        ok: false,
        sourceUrl,
        classification: 'invalid',
        trust,
        message: 'Downloaded plugin bundle does not match its registry entry.',
        issues: mismatch,
      }
    }

    const digestMismatch = marketplaceComponentDigestMismatchIssuesSync(stage, manifest, {
      bytesLabel: 'downloaded bytes',
      blockedFileMessage: (path) => `component file "${path}" cannot be installed from marketplace bundles.`,
    })
    if (digestMismatch.length > 0) {
      await rm(stage, { recursive: true, force: true })
      return {
        ok: false,
        sourceUrl,
        classification: 'invalid',
        trust,
        message: 'Downloaded plugin bundle component digests do not match its signed manifest.',
        issues: digestMismatch,
      }
    }

    return {
      ok: true,
      sourceUrl,
      stagedBundlePath: stage,
      classification,
      manifest,
      trust,
      loadEligible: isLoadEligible(trust.status),
    }
  } catch (error) {
    if (stage) await rm(stage, { recursive: true, force: true }).catch(() => undefined)
    return {
      ok: false,
      sourceUrl,
      message: error instanceof DownloadHttpError ? error.message : formatError(error),
      ...(error instanceof DownloadHttpError ? { statusCode: error.statusCode } : {}),
    }
  }
}

function classifyMarketplaceTrust(entry: MarketplacePluginEntry, trust: ModuleTrust): MarketplacePluginTrustClassification {
  if (trust.status === 'invalid') return 'invalid'
  if (trust.status === 'unsigned') return 'unsigned'
  if (entry.publisher.verified && trust.status === 'trusted') return 'verified'
  return 'community'
}

async function copyPackagedMarketplacePluginBundle(
  source: GithubTreeSource,
  entryId: string,
  stage: string,
  resolver: MarketplaceResourceResolver
): Promise<boolean> {
  const relativePath = packagedMarketplacePluginRelativePath(source, entryId)
  if (!relativePath) return false
  const packagedBundlePath = resolver(relativePath)
  if (!packagedBundlePath) return false
  await cp(packagedBundlePath, stage, { recursive: true, force: true })
  return true
}

function packagedMarketplacePluginRelativePath(source: GithubTreeSource, entryId: string): string | null {
  if (
    source.owner !== MARKETPLACE_CANONICAL_SOURCE.owner ||
    source.repo !== MARKETPLACE_CANONICAL_SOURCE.repo ||
    source.ref !== MARKETPLACE_CANONICAL_SOURCE.ref
  ) {
    return null
  }
  const expectedPath = `plugins/${entryId}`
  return source.path === expectedPath ? expectedPath : null
}

function isPackagedSeedFallbackEligible(error: unknown, source: GithubTreeSource): boolean {
  const rootUrl = githubContentsUrl(source)
  if (error instanceof DownloadHttpError) {
    return error.url === rootUrl && isSourceUnavailableStatus(error.statusCode)
  }
  if (error instanceof DownloadNetworkError) {
    return error.url === rootUrl
  }
  return false
}

function isSourceUnavailableStatus(statusCode: number): boolean {
  return statusCode === 404 || statusCode === 410 || statusCode === 502 || statusCode === 503 || statusCode === 504
}

type ResolvedDownloadedManifest =
  | { ok: true; manifest: MarketplacePluginAuthoringManifest; trust: ModuleTrust }
  | { ok: false; classification: 'unsigned' | 'invalid'; trust?: ModuleTrust; message: string; issues?: MarketplaceManifestIssue[] }

// Resolve a downloaded plugin.json under the shared optionally-signed contract,
// then layer trust classification on top. A resolved manifest carries its trust
// status; an unresolved one is reported as an unsigned (id-bearing, no signature)
// or hard-invalid block so the caller can fail closed with the right label.
function resolveDownloadedManifest(source: string, trustContext: ModuleTrustContext): ResolvedDownloadedManifest {
  const resolved = resolveOptionallySignedManifest(source)
  if (resolved.ok) {
    return { ok: true, manifest: resolved.manifest, trust: classifyModuleTrust(resolved.manifest, trustContext) }
  }
  const unsigned = classifyUnsignedManifest(source, trustContext)
  if (unsigned) {
    return { ok: false, classification: 'unsigned', trust: unsigned, message: 'Downloaded plugin bundle is unsigned.', issues: resolved.issues }
  }
  return { ok: false, classification: 'invalid', message: 'Downloaded plugin bundle plugin.json is invalid.', issues: resolved.issues }
}

function classifyUnsignedManifest(source: string, trustContext: ModuleTrustContext): ModuleTrust | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(source) as Record<string, unknown>
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const candidate = parsed as Record<string, unknown>
  if (candidate.signature !== undefined || typeof candidate.id !== 'string' || candidate.id.trim().length === 0) {
    return null
  }
  return classifySignedManifestTrust({ id: candidate.id }, trustContext)
}

function registryMismatchIssues(
  entry: MarketplacePluginEntry,
  manifest: MarketplacePluginAuthoringManifest
): MarketplaceManifestIssue[] {
  const issues: MarketplaceManifestIssue[] = []
  if (entry.id !== manifest.id) issues.push({ path: 'id', message: `expected ${entry.id}, got ${manifest.id}.` })
  if (entry.name !== manifest.displayName) {
    issues.push({ path: 'name', message: `expected ${entry.name}, got ${manifest.displayName}.` })
  }
  if (entry.latest !== manifest.version) {
    issues.push({ path: 'latest', message: `expected ${entry.latest}, got ${manifest.version}.` })
  }
  const provides = componentKinds(manifest)
  if (entry.provides.join(',') !== provides.join(',')) {
    issues.push({ path: 'provides', message: `expected ${entry.provides.join(', ')}, got ${provides.join(', ')}.` })
  }
  if (JSON.stringify(entry.signature) !== JSON.stringify(manifest.signature)) {
    issues.push({ path: 'signature', message: 'registry signature does not match downloaded plugin.json signature.' })
  }
  return issues
}

function componentKinds(manifest: MarketplacePluginAuthoringManifest): MarketplaceComponentKind[] {
  return MARKETPLACE_COMPONENT_KINDS.filter((kind) => manifest.components[kind] !== undefined)
}

async function downloadGithubTree(
  source: GithubTreeSource,
  stage: string,
  fetcher: MarketplacePluginDownloadFetch,
  timeoutMs: number | undefined,
  limits: DownloadLimits
): Promise<void> {
  const state: DownloadState = { files: 0, bytes: 0, dirRequests: 0 }
  const rootUrl = githubContentsUrl(source)
  await downloadGithubContentsDirectory(rootUrl, source.path, source.path, stage, fetcher, timeoutMs, limits, state)
}

async function downloadGithubContentsDirectory(
  apiUrl: string,
  basePath: string,
  currentPath: string,
  stage: string,
  fetcher: MarketplacePluginDownloadFetch,
  timeoutMs: number | undefined,
  limits: DownloadLimits,
  state: DownloadState,
  depth = 0
): Promise<void> {
  if (depth > MAX_GITHUB_DIR_DEPTH) {
    throw new Error(`Plugin source directory tree is nested deeper than ${MAX_GITHUB_DIR_DEPTH} levels.`)
  }
  if (state.dirRequests >= MAX_GITHUB_DIR_REQUESTS) {
    throw new Error(`Plugin source directory tree needs more than ${MAX_GITHUB_DIR_REQUESTS} listing requests.`)
  }
  state.dirRequests += 1
  const body = await fetchText(apiUrl, fetcher, timeoutMs, { accept: 'application/vnd.github+json' }, limits.maxFileBytes)
  const parsed = JSON.parse(body) as GithubContentsEntry | GithubContentsEntry[]
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  for (const entry of entries) {
    if (entry.type === 'dir') {
      if (!entry.url) throw new Error(`GitHub directory ${entry.path ?? currentPath} is missing a contents URL.`)
      await downloadGithubContentsDirectory(entry.url, basePath, entry.path ?? currentPath, stage, fetcher, timeoutMs, limits, state, depth + 1)
      continue
    }
    if (entry.type !== 'file') {
      throw new Error(`GitHub entry ${entry.path ?? currentPath} is not a regular file.`)
    }
    if (!entry.download_url) {
      throw new Error(`GitHub file ${entry.path ?? currentPath} is missing a download URL.`)
    }
    const relPath = relativeGithubPath(basePath, entry.path)
    await downloadFile(entry.download_url, join(stage, relPath), fetcher, timeoutMs, limits, state)
  }
}

// ---------------------------------------------------------------------------
// Claude Code plugin sources (MC-1561)
// ---------------------------------------------------------------------------

export type ClaudeCodePluginDownloadOptions = {
  entry: MarketplacePluginEntry
  stagingRoot?: string
  fetcher?: MarketplacePluginDownloadFetch
  timeoutMs?: number
  maxFiles?: number
  maxFileBytes?: number
  maxTotalBytes?: number
  /**
   * Fetch exactly this commit instead of the source's own ref. The install
   * passes the ref the pre-trust verify resolved and disclosed, so the user
   * can never trust listing A and install content B (a mutable default-branch
   * source repushed between the prompt and the install).
   */
  refOverride?: string
}

export type ClaudeCodePluginDownloadResult =
  | {
    ok: true
    sourceUrl: string
    /** Staged copy of the plugin subtree (`.claude-plugin/` + `skills/`). */
    stagedPath: string
    /** Skill folder names under the plugin's skills/ dir (each has a SKILL.md). */
    skillDirs: string[]
    /** The plugin's own name from .claude-plugin/plugin.json. */
    claudeName: string
    /** The commit actually fetched (mutable refs resolve to a sha up front). */
    resolvedRef: string
  }
  | { ok: false; sourceUrl: string; message: string; statusCode?: number }

/**
 * Download a Claude Code plugin's installable content: `.claude-plugin/`
 * (the manifest) and `skills/` (the skill folders). Claude plugins are not
 * Multicode bundles — no plugin.json contract, no signature, no digests — so
 * this stages only what the skills install consumes, under the same host
 * allowlist and file/byte limits as bundle downloads. Commands/agents/hooks
 * in the plugin are NOT downloaded or installed; skills are the one component
 * Multicode can honestly deliver today.
 */
export async function downloadClaudeCodePluginSource(
  options: ClaudeCodePluginDownloadOptions
): Promise<ClaudeCodePluginDownloadResult> {
  const sourceUrl = options.entry.source?.trim() ?? ''
  if (!sourceUrl) {
    return { ok: false, sourceUrl: '', message: 'Claude Code plugin entry has no source to download.' }
  }
  const parsedSource = parseHttpsUrl(sourceUrl)
  if (!parsedSource.ok) return { ok: false, sourceUrl, message: parsedSource.message }
  const parsedGithub = parseClaudePluginGithubSource(parsedSource.url)
  if (!parsedGithub) {
    return { ok: false, sourceUrl, message: 'Claude Code plugins install from a GitHub repo or pinned subtree source.' }
  }

  const stagingRoot = options.stagingRoot ?? defaultMarketplacePluginStagingRoot()
  const fetcher = options.fetcher ?? defaultFetch

  // Resolve mutable refs (bare-repo sources ride the default branch) to a
  // commit sha BEFORE walking, so one download can never read a torn tree —
  // and so the verify-time listing and the install fetch the SAME commit
  // (refOverride carries the verify's pin into the install).
  let github = parsedGithub
  const requestedRef = options.refOverride ?? parsedGithub.ref
  if (COMMIT_SHA_REF_PATTERN.test(requestedRef)) {
    github = { ...parsedGithub, ref: requestedRef }
  } else {
    try {
      const commitBody = await fetchTextForClaude(
        `https://api.github.com/repos/${parsedGithub.owner}/${parsedGithub.repo}/commits/${encodeURIComponent(requestedRef)}`,
        fetcher,
        options.timeoutMs,
        options.maxFileBytes ?? DEFAULT_MARKETPLACE_PLUGIN_MAX_FILE_BYTES
      )
      const sha = (JSON.parse(commitBody) as { sha?: unknown }).sha
      if (typeof sha !== 'string' || !COMMIT_SHA_REF_PATTERN.test(sha)) {
        return { ok: false, sourceUrl, message: 'Could not resolve the plugin source branch to a commit.' }
      }
      github = { ...parsedGithub, ref: sha }
    } catch (error) {
      return {
        ok: false,
        sourceUrl,
        message: error instanceof DownloadHttpError ? error.message : formatError(error),
        ...(error instanceof DownloadHttpError ? { statusCode: error.statusCode } : {}),
      }
    }
  }
  const limits: DownloadLimits = {
    maxFiles: options.maxFiles ?? DEFAULT_MARKETPLACE_PLUGIN_MAX_FILES,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MARKETPLACE_PLUGIN_MAX_FILE_BYTES,
    maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MARKETPLACE_PLUGIN_MAX_TOTAL_BYTES,
  }

  let stage: string | null = null
  try {
    await mkdir(stagingRoot, { recursive: true })
    stage = await mkdtemp(join(stagingRoot, `${options.entry.id}-claude-`))
    const state: DownloadState = { files: 0, bytes: 0, dirRequests: 0 }

    // The Claude manifest first: a source without one is not a Claude plugin,
    // and failing before the skills fetch keeps the error specific.
    try {
      await downloadGithubContentsDirectory(
        githubSubtreeContentsUrl(github, '.claude-plugin'),
        github.path,
        github.path,
        stage,
        fetcher,
        options.timeoutMs,
        limits,
        state
      )
    } catch (error) {
      if (error instanceof DownloadHttpError && error.statusCode === 404) {
        return { ok: false, sourceUrl, message: 'This source has no .claude-plugin/plugin.json, so it is not a Claude Code plugin.', statusCode: 404 }
      }
      throw error
    }
    const claudeName = await readClaudePluginName(join(stage, '.claude-plugin', 'plugin.json'))
    if (claudeName === null) {
      return { ok: false, sourceUrl, message: 'The plugin’s .claude-plugin/plugin.json is invalid (a name is required).' }
    }

    try {
      await downloadGithubContentsDirectory(
        githubSubtreeContentsUrl(github, 'skills'),
        github.path,
        github.path,
        stage,
        fetcher,
        options.timeoutMs,
        limits,
        state
      )
    } catch (error) {
      if (error instanceof DownloadHttpError && error.statusCode === 404) {
        return { ok: false, sourceUrl, message: 'This Claude Code plugin bundles no skills. Multicode installs plugin skills only; its commands run inside Claude Code sessions.', statusCode: 404 }
      }
      throw error
    }

    const skillDirs = await stagedSkillDirs(join(stage, 'skills'))
    if (skillDirs.length === 0) {
      return { ok: false, sourceUrl, message: 'This Claude Code plugin bundles no skills. Multicode installs plugin skills only; its commands run inside Claude Code sessions.' }
    }

    const result: ClaudeCodePluginDownloadResult = {
      ok: true,
      sourceUrl,
      stagedPath: stage,
      skillDirs,
      claudeName,
      resolvedRef: github.ref,
    }
    stage = null // ownership transfers to the caller, which removes it
    return result
  } catch (error) {
    return {
      ok: false,
      sourceUrl,
      message: error instanceof DownloadHttpError ? error.message : formatError(error),
      ...(error instanceof DownloadHttpError ? { statusCode: error.statusCode } : {}),
    }
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true }).catch(() => undefined)
  }
}

function githubSubtreeContentsUrl(source: GithubTreeSource, subPath: string): string {
  const fullPath = source.path === '' ? subPath : `${source.path}/${subPath}`
  return githubContentsUrl({ ...source, path: fullPath })
}

async function readClaudePluginName(manifestPath: string): Promise<string | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const name = (parsed as Record<string, unknown>).name
  return typeof name === 'string' && name.trim().length > 0 ? name.trim() : null
}

async function stagedSkillDirs(skillsRoot: string): Promise<string[]> {
  let dirents
  try {
    dirents = await readdir(skillsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const dirs: string[] = []
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue
    try {
      await readFile(join(skillsRoot, dirent.name, 'SKILL.md'), 'utf8')
      dirs.push(dirent.name)
    } catch {
      // a folder without SKILL.md is not a skill
    }
  }
  return dirs.sort()
}

async function downloadGenericPluginSource(
  source: URL,
  stage: string,
  fetcher: MarketplacePluginDownloadFetch,
  timeoutMs: number | undefined,
  limits: DownloadLimits
): Promise<void> {
  const state: DownloadState = { files: 0, bytes: 0, dirRequests: 0 }
  const pluginUrl = source.pathname.endsWith('/plugin.json') ? source : new URL(`${ensureTrailingSlash(source.toString())}plugin.json`)
  await downloadFile(pluginUrl.toString(), join(stage, 'plugin.json'), fetcher, timeoutMs, limits, state)
  // Parse without requiring a signature so an unsigned (mcp/skills-only) bundle
  // still enumerates its component files; the strict signature/kind gate runs
  // later against the staged bytes.
  const manifestResult = parseMarketplacePluginAuthoringManifest(await readFile(join(stage, 'plugin.json'), 'utf8'))
  if (!manifestResult.ok) return

  const base = new URL('.', pluginUrl)
  for (const relPath of marketplaceComponentDigestPaths(manifestResult.manifest)) {
    await downloadFile(new URL(relPath, base).toString(), join(stage, relPath), fetcher, timeoutMs, limits, state)
  }
}

async function downloadFile(
  url: string,
  destination: string,
  fetcher: MarketplacePluginDownloadFetch,
  timeoutMs: number | undefined,
  limits: DownloadLimits,
  state: DownloadState
): Promise<void> {
  if (state.files >= limits.maxFiles) throw new Error(`Plugin bundle contains more than ${limits.maxFiles} files.`)
  const body = await fetchBytes(url, fetcher, timeoutMs, { accept: '*/*' }, limits.maxFileBytes)
  if (state.bytes + body.byteLength > limits.maxTotalBytes) {
    throw new Error(`Plugin bundle exceeds ${limits.maxTotalBytes} bytes.`)
  }
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, body)
  state.files += 1
  state.bytes += body.byteLength
}

async function fetchText(
  url: string,
  fetcher: MarketplacePluginDownloadFetch,
  timeoutMs: number | undefined,
  headers: Record<string, string>,
  maxBytes: number
): Promise<string> {
  return (await fetchBytes(url, fetcher, timeoutMs, headers, maxBytes)).toString('utf8')
}

async function fetchBytes(
  url: string,
  fetcher: MarketplacePluginDownloadFetch,
  timeoutMs: number | undefined,
  headers: Record<string, string>,
  maxBytes: number
): Promise<Buffer> {
  const parsed = parseHttpsUrl(url)
  if (!parsed.ok) throw new Error(parsed.message)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_MARKETPLACE_PLUGIN_DOWNLOAD_TIMEOUT_MS)
  try {
    let response: Response
    try {
      response = await fetcher(parsed.url.toString(), { method: 'GET', headers, signal: controller.signal })
    } catch (error) {
      throw new DownloadNetworkError(`Marketplace plugin download failed. ${formatError(error)}`, parsed.url.toString())
    }
    if (!response.ok) {
      throw new DownloadHttpError(
        `Marketplace plugin download failed with HTTP ${response.status}.`,
        response.status,
        parsed.url.toString()
      )
    }
    let arrayBuffer: ArrayBuffer
    try {
      arrayBuffer = await response.arrayBuffer()
    } catch (error) {
      throw new DownloadNetworkError(
        `Marketplace plugin download response could not be read. ${formatError(error)}`,
        parsed.url.toString()
      )
    }
    const body = Buffer.from(arrayBuffer)
    if (body.byteLength > maxBytes) throw new Error(`Downloaded file exceeds ${maxBytes} bytes.`)
    return body
  } finally {
    clearTimeout(timeout)
  }
}

function parseGithubTreeSource(url: URL): GithubTreeSource | null {
  if (url.hostname !== 'github.com') return null
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length < 5 || segments[2] !== 'tree') return null
  return {
    owner: segments[0],
    repo: segments[1],
    ref: segments[3],
    path: segments.slice(4).join('/'),
  }
}

// Claude Code plugin sources come in two shapes from the generated catalogue:
// a pinned monorepo subtree (`/tree/<sha>/<path>`, same as bundle sources) or
// a bare repo root (`https://github.com/<owner>/<repo>`), where the plugin is
// unpinned and installs from the default branch (`ref=HEAD` on the contents
// API).
function parseClaudePluginGithubSource(url: URL): GithubTreeSource | null {
  const tree = parseGithubTreeSource(url)
  if (tree) return tree
  if (url.hostname !== 'github.com') return null
  const segments = url.pathname.replace(/\.git$/, '').split('/').filter(Boolean)
  if (segments.length !== 2) return null
  return { owner: segments[0], repo: segments[1], ref: 'HEAD', path: '' }
}

function githubContentsUrl(source: GithubTreeSource): string {
  return `https://api.github.com/repos/${source.owner}/${source.repo}/contents/${source.path}?ref=${encodeURIComponent(source.ref)}`
}

function relativeGithubPath(basePath: string, path: string | undefined): string {
  // A repo-root source (claude plugins) has basePath '' — every repo path is
  // already bundle-relative; the safety check below still applies.
  const relPath =
    basePath === ''
      ? path ?? ''
      : (() => {
          if (!path?.startsWith(`${basePath}/`) && path !== basePath) {
            throw new Error(`GitHub file path ${path ?? '(missing)'} is outside the plugin source path.`)
          }
          return path === basePath ? '' : path.slice(basePath.length + 1)
        })()
  if (!isSafeManifestRelativePath(relPath)) {
    throw new Error(`GitHub file path ${path} does not resolve to a safe bundle-relative path.`)
  }
  return relPath
}

function parseHttpsUrl(value: string): { ok: true; url: URL } | { ok: false; message: string } {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { ok: false, message: 'Marketplace plugin source URL is invalid.' }
  }
  if (url.protocol !== 'https:') return { ok: false, message: 'Marketplace plugin source URL must use HTTPS.' }
  const extraHosts = parseMarketplaceExtraHosts(process.env[MARKETPLACE_EXTRA_HOSTS_ENV])
  if (!isMarketplaceSourceHostAllowed(url.hostname, extraHosts)) {
    return { ok: false, message: `Marketplace plugin source host "${url.hostname}" is not on the allowlist.` }
  }
  return { ok: true, url }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

async function defaultFetch(url: string, init: RequestInit): Promise<Response> {
  if (typeof globalThis.fetch !== 'function') throw new Error('fetch is not available in this runtime.')
  return globalThis.fetch(url, init)
}

class DownloadHttpError extends Error {
  constructor(message: string, readonly statusCode: number, readonly url: string) {
    super(message)
  }
}

class DownloadNetworkError extends Error {
  constructor(message: string, readonly url: string) {
    super(message)
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
