import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import type {
  MarketplaceComponentKind,
  MarketplaceManifestIssue,
  MarketplacePluginEntry,
  MarketplacePluginManifest,
} from '../../shared/marketplace'
import { MARKETPLACE_COMPONENT_KINDS, parseMarketplacePluginManifest } from '../../shared/marketplace'
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
    manifest: MarketplacePluginManifest
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
    const parsedManifest = parseMarketplacePluginManifest(manifestSource)
    if (!parsedManifest.ok) {
      const unsigned = classifyUnsignedManifest(manifestSource, options.trustContext)
      await rm(stage, { recursive: true, force: true })
      if (unsigned) {
        return {
          ok: false,
          sourceUrl,
          classification: 'unsigned',
          trust: unsigned,
          message: 'Downloaded plugin bundle is unsigned.',
          issues: parsedManifest.issues,
        }
      }
      return {
        ok: false,
        sourceUrl,
        classification: 'invalid',
        message: 'Downloaded plugin bundle plugin.json is invalid.',
        issues: parsedManifest.issues,
      }
    }

    const manifest = parsedManifest.manifest
    const trust = classifyModuleTrust(manifest, options.trustContext)
    const classification = classifyMarketplaceTrust(options.entry, trust)
    if (classification === 'invalid' || classification === 'unsigned') {
      await rm(stage, { recursive: true, force: true })
      return {
        ok: false,
        sourceUrl,
        classification,
        trust,
        message: classification === 'invalid'
          ? 'Downloaded plugin bundle signature is invalid.'
          : 'Downloaded plugin bundle is unsigned.',
        issues: [{ path: 'signature', message: classification === 'invalid' ? 'Invalid signature.' : 'signature is required.' }],
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
  if (source.owner !== 'multicode-labs' || source.repo !== 'marketplace' || source.ref !== 'main') return null
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
  manifest: MarketplacePluginManifest
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

function componentKinds(manifest: MarketplacePluginManifest): MarketplaceComponentKind[] {
  return MARKETPLACE_COMPONENT_KINDS.filter((kind) => manifest.components[kind] !== undefined)
}

async function downloadGithubTree(
  source: GithubTreeSource,
  stage: string,
  fetcher: MarketplacePluginDownloadFetch,
  timeoutMs: number | undefined,
  limits: DownloadLimits
): Promise<void> {
  const state: DownloadState = { files: 0, bytes: 0 }
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
  state: DownloadState
): Promise<void> {
  const body = await fetchText(apiUrl, fetcher, timeoutMs, { accept: 'application/vnd.github+json' }, limits.maxFileBytes)
  const parsed = JSON.parse(body) as GithubContentsEntry | GithubContentsEntry[]
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  for (const entry of entries) {
    if (entry.type === 'dir') {
      if (!entry.url) throw new Error(`GitHub directory ${entry.path ?? currentPath} is missing a contents URL.`)
      await downloadGithubContentsDirectory(entry.url, basePath, entry.path ?? currentPath, stage, fetcher, timeoutMs, limits, state)
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

async function downloadGenericPluginSource(
  source: URL,
  stage: string,
  fetcher: MarketplacePluginDownloadFetch,
  timeoutMs: number | undefined,
  limits: DownloadLimits
): Promise<void> {
  const state: DownloadState = { files: 0, bytes: 0 }
  const pluginUrl = source.pathname.endsWith('/plugin.json') ? source : new URL(`${ensureTrailingSlash(source.toString())}plugin.json`)
  await downloadFile(pluginUrl.toString(), join(stage, 'plugin.json'), fetcher, timeoutMs, limits, state)
  const manifestResult = parseMarketplacePluginManifest(await readFile(join(stage, 'plugin.json'), 'utf8'))
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

function githubContentsUrl(source: GithubTreeSource): string {
  return `https://api.github.com/repos/${source.owner}/${source.repo}/contents/${source.path}?ref=${encodeURIComponent(source.ref)}`
}

function relativeGithubPath(basePath: string, path: string | undefined): string {
  if (!path?.startsWith(`${basePath}/`) && path !== basePath) {
    throw new Error(`GitHub file path ${path ?? '(missing)'} is outside the plugin source path.`)
  }
  const relPath = path === basePath ? '' : path.slice(basePath.length + 1)
  if (!isSafeManifestRelativePath(relPath)) {
    throw new Error(`GitHub file path ${path} does not resolve to a safe bundle-relative path.`)
  }
  return relPath
}

function parseHttpsUrl(value: string): { ok: true; url: URL } | { ok: false; message: string } {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return { ok: false, message: 'Marketplace plugin source URL must use HTTPS.' }
    return { ok: true, url }
  } catch {
    return { ok: false, message: 'Marketplace plugin source URL is invalid.' }
  }
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
