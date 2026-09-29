import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

import type { MarketplaceTrustPin } from '../../shared/electron-api'
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
  marketplaceAutomationPayloadIssuesSync,
  marketplaceComponentDigestMismatchIssuesSync,
  marketplaceComponentDigestPaths,
} from '../../../packages/module-sdk/src/plugin-component-digests'
import {
  classifySignedManifestTrust,
  isLoadEligible,
  type ModuleTrust,
  type ModuleTrustContext,
} from '../modules/module-signature'
import { findMarketplaceResourcePath, type MarketplaceResourceResolver } from './resources'
import { withObservedUnsignedDigests } from './unsigned-component-digests'
import { verifyBundledSkillFolder } from './skill-content'
import { readStudioEnv } from '../../shared/studio-env'

const DEFAULT_MARKETPLACE_PLUGIN_STAGING_DIR = 'marketplace-plugin-staging'
const DEFAULT_MARKETPLACE_PLUGIN_DOWNLOAD_TIMEOUT_MS = 30_000
const DEFAULT_MARKETPLACE_PLUGIN_MAX_FILES = 500
const DEFAULT_MARKETPLACE_PLUGIN_MAX_FILE_BYTES = 5 * 1024 * 1024
const DEFAULT_MARKETPLACE_PLUGIN_MAX_TOTAL_BYTES = 25 * 1024 * 1024

export type MarketplacePluginDownloadFetch = (url: string, init: RequestInit) => Promise<Response>

type MarketplacePluginTrustClassification = 'verified' | 'community' | 'unsigned' | 'invalid'

export type MarketplacePluginDownloadOptions = {
  entry: MarketplacePluginEntry
  trustContext: ModuleTrustContext
  /**
   * Download a GitHub `tree/` source at exactly this commit, not wherever its
   * ref points now. The install passes the commit the trust prompt's verify
   * read, so a branch that moves between the prompt and the click installs
   * nothing rather than something nobody reviewed.
   */
  commitSha?: string
  /**
   * Let an unsigned bundle carrying module code through the unsigned gate.
   * Only ever derived in main from a trust grant for a GitHub-URL install the
   * person explicitly trusted (trust-tokens.ts); the registry path never sets
   * it, and a renderer cannot.
   */
  allowUnsignedCode?: boolean
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
      /** What was staged, for a trust prompt to disclose and an install to re-check. */
      pin: MarketplaceTrustPin
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

// A repository and ref as they may appear in a `tree/` URL. The ref is a
// branch, tag or commit; it never starts with `-`, so it can never read as an
// option to anything it is handed to.
const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/
const GITHUB_REF_PATTERN = /^(?!-)[A-Za-z0-9._-]{1,255}$/
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/

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

export function defaultMarketplacePluginStagingRoot(userDataDir?: string): string {
  return join(userDataDir?.trim() || tmpdir(), DEFAULT_MARKETPLACE_PLUGIN_STAGING_DIR)
}

export async function downloadMarketplacePluginBundle(
  options: MarketplacePluginDownloadOptions,
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

  const github = parseGithubTreeSource(parsedSource.url)
  if (github === 'invalid') {
    return { ok: false, sourceUrl, message: 'Marketplace plugin source is not a usable GitHub tree URL.' }
  }

  let stage: string | null = null
  try {
    await mkdir(stagingRoot, { recursive: true })
    stage = await mkdtemp(join(stagingRoot, `${options.entry.id}-`))
    let commitSha: string | undefined
    if (github) {
      try {
        // Resolved once, up front: every listing and file below is read at
        // this commit, so the bundle cannot change underneath the walk, and
        // the commit is what a later install is pinned to.
        commitSha = await resolveGithubCommit(github, options.commitSha, fetcher, options.timeoutMs)
        // A repository-root bundle (an extension installed from its own
        // repository) shares the tree with the extension's sources, tests and
        // docs; only plugin.json and the component folders it names are the
        // bundle, so only they are read. A registry folder is the bundle whole.
        if (github.path === '') {
          await downloadGithubRootBundle({ ...github, ref: commitSha }, stage, fetcher, options.timeoutMs, limits)
        } else {
          await downloadGithubTree({ ...github, ref: commitSha }, stage, fetcher, options.timeoutMs, limits)
        }
      } catch (error) {
        const eligible = isPackagedSeedFallbackEligible(error, github, commitSha)
        // The seed is the app's own copy, read at no commit.
        commitSha = undefined
        if (!eligible) throw error
        await rm(stage, { recursive: true, force: true })
        stage = await mkdtemp(join(stagingRoot, `${options.entry.id}-`))
        const copiedSeedBundle = await copyPackagedMarketplacePluginBundle(
          github,
          options.entry.id,
          stage,
          packagedResourceResolver,
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
    // unsigned module must never become load-eligible, so gate on signature
    // presence (id-trust would otherwise promote an unsigned manifest to
    // 'trusted' and slip a code component past the classification check). The
    // one exception is a GitHub-URL install the person explicitly trusted as
    // code, which main alone can ask for.
    if (!manifest.signature && hasCodeBearingComponent(manifest.components) && options.allowUnsignedCode !== true) {
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

    const digestMismatch = marketplaceComponentDigestMismatchIssuesSync(
      stage,
      withObservedUnsignedDigests(stage, manifest),
      {
        bytesLabel: 'downloaded bytes',
        blockedFileMessage: (path) => `component file "${path}" cannot be installed from marketplace bundles.`,
      },
    )
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

    // An automation component ships a definition the app will schedule and run.
    // Refuse a payload that is not one before the bundle is handed on, so the
    // failure names the manifest rather than surfacing at install time.
    const automationIssues = marketplaceAutomationPayloadIssuesSync(stage, manifest.components)
    if (automationIssues.length > 0) {
      await rm(stage, { recursive: true, force: true })
      return {
        ok: false,
        sourceUrl,
        classification: 'invalid',
        trust,
        message: 'Downloaded plugin bundle automation payload is not a valid automation definition.',
        issues: automationIssues,
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
      pin: await stagedBundlePin(stage, commitSha),
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

function classifyMarketplaceTrust(
  entry: MarketplacePluginEntry,
  trust: ModuleTrust,
): MarketplacePluginTrustClassification {
  if (trust.status === 'invalid') return 'invalid'
  if (trust.status === 'unsigned') return 'unsigned'
  if (entry.publisher.verified && trust.status === 'trusted') return 'verified'
  return 'community'
}

async function copyPackagedMarketplacePluginBundle(
  source: GithubTreeSource,
  entryId: string,
  stage: string,
  resolver: MarketplaceResourceResolver,
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

// The first request of the walk — resolving the commit, or listing the root
// when the ref already is one — is the one whose failure means "the source
// is not reachable", which is when the packaged seed may stand in.
function isPackagedSeedFallbackEligible(error: unknown, source: GithubTreeSource, commitSha?: string): boolean {
  const firstUrls = new Set([githubCommitUrl(source), githubContentsUrl(source)])
  if (commitSha) firstUrls.add(githubContentsUrl({ ...source, ref: commitSha }))
  if (error instanceof DownloadHttpError) {
    return firstUrls.has(error.url) && isSourceUnavailableStatus(error.statusCode)
  }
  if (error instanceof DownloadNetworkError) {
    return firstUrls.has(error.url)
  }
  return false
}

function isSourceUnavailableStatus(statusCode: number): boolean {
  return statusCode === 404 || statusCode === 410 || statusCode === 502 || statusCode === 503 || statusCode === 504
}

type ResolvedDownloadedManifest =
  | { ok: true; manifest: MarketplacePluginAuthoringManifest; trust: ModuleTrust }
  | {
      ok: false
      classification: 'unsigned' | 'invalid'
      trust?: ModuleTrust
      message: string
      issues?: MarketplaceManifestIssue[]
    }

// Resolve a downloaded plugin.json under the shared optionally-signed contract,
// then layer trust classification on top. A resolved manifest carries its trust
// status; an unresolved one is reported as an unsigned (id-bearing, no signature)
// or hard-invalid block so the caller can fail closed with the right label.
function resolveDownloadedManifest(source: string, trustContext: ModuleTrustContext): ResolvedDownloadedManifest {
  const resolved = resolveOptionallySignedManifest(source)
  if (resolved.ok) {
    return {
      ok: true,
      manifest: resolved.manifest,
      trust: classifySignedManifestTrust(resolved.manifest, trustContext),
    }
  }
  const unsigned = classifyUnsignedManifest(source, trustContext)
  if (unsigned) {
    return {
      ok: false,
      classification: 'unsigned',
      trust: unsigned,
      message: 'Downloaded plugin bundle is unsigned.',
      issues: resolved.issues,
    }
  }
  return {
    ok: false,
    classification: 'invalid',
    message: 'Downloaded plugin bundle plugin.json is invalid.',
    issues: resolved.issues,
  }
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
  manifest: MarketplacePluginAuthoringManifest,
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
  limits: DownloadLimits,
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
  depth = 0,
): Promise<void> {
  if (depth > MAX_GITHUB_DIR_DEPTH) {
    throw new Error(`Plugin source directory tree is nested deeper than ${MAX_GITHUB_DIR_DEPTH} levels.`)
  }
  if (state.dirRequests >= MAX_GITHUB_DIR_REQUESTS) {
    throw new Error(`Plugin source directory tree needs more than ${MAX_GITHUB_DIR_REQUESTS} listing requests.`)
  }
  state.dirRequests += 1
  const body = await fetchText(
    apiUrl,
    fetcher,
    timeoutMs,
    { accept: 'application/vnd.github+json' },
    limits.maxFileBytes,
  )
  const parsed = JSON.parse(body) as GithubContentsEntry | GithubContentsEntry[]
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  for (const entry of entries) {
    if (entry.type === 'dir') {
      if (!entry.url) throw new Error(`GitHub directory ${entry.path ?? currentPath} is missing a contents URL.`)
      await downloadGithubContentsDirectory(
        entry.url,
        basePath,
        entry.path ?? currentPath,
        stage,
        fetcher,
        timeoutMs,
        limits,
        state,
        depth + 1,
      )
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

// plugin.json first, then each component path it declares, all at the commit
// already resolved. A path that is not in the tree fails the fetch here; a
// plugin.json that does not parse stages alone, so the manifest checks after
// the walk report what is wrong with it.
async function downloadGithubRootBundle(
  source: GithubTreeSource,
  stage: string,
  fetcher: MarketplacePluginDownloadFetch,
  timeoutMs: number | undefined,
  limits: DownloadLimits,
): Promise<void> {
  const state: DownloadState = { files: 0, bytes: 0, dirRequests: 0 }
  await downloadGithubContentsDirectory(
    githubContentsUrl({ ...source, path: 'plugin.json' }),
    '',
    'plugin.json',
    stage,
    fetcher,
    timeoutMs,
    limits,
    state,
  )
  const manifest = parseMarketplacePluginAuthoringManifest(await readFile(join(stage, 'plugin.json'), 'utf8'))
  if (!manifest.ok) return
  for (const kind of MARKETPLACE_COMPONENT_KINDS) {
    const componentPath = manifest.manifest.components[kind]?.path
    if (!componentPath) continue
    await downloadGithubContentsDirectory(
      githubContentsUrl({ ...source, path: componentPath }),
      '',
      componentPath,
      stage,
      fetcher,
      timeoutMs,
      limits,
      state,
    )
  }
}

// ---------------------------------------------------------------------------
// Claude Code plugin sources (bundled snapshot content)
// ---------------------------------------------------------------------------

/**
 * Structured log hook for the marketplace verify/install pipeline. Events are
 * short kebab-ish identifiers with a small detail record; the IPC layer wires
 * them into the diagnostics log so a failed verify or install is never
 * invisible.
 */
export type MarketplaceInstallLog = (event: string, detail?: Record<string, unknown>) => void

export type ClaudeCodePluginDownloadOptions = {
  entry: MarketplacePluginEntry
  stagingRoot?: string
  /**
   * Refuse to stage when the bundled content identity differs from this pin.
   * The install passes the identity the pre-trust verify disclosed, so the
   * user can never trust listing A and install content B (an app/catalogue
   * update swapping the bundled payload between the prompt and the install).
   */
  refOverride?: string
  /** Test seam for packaged resource resolution. */
  packagedResourceResolver?: MarketplaceResourceResolver
  log?: MarketplaceInstallLog
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
      /** The staged listing, for a trust prompt to disclose and an install to re-check. */
      pin: MarketplaceTrustPin
      /**
       * Names of skills the entry lists but that shipped metadata-only (no
       * bundled content — a snapshot capture cap), so the install can tell the
       * user which listed skills it did NOT install rather than silently
       * dropping them.
       */
      metadataOnlySkills: string[]
    }
  | { ok: false; sourceUrl: string; message: string; statusCode?: number }

const CLAUDE_PLUGIN_NOT_BUNDLED_MESSAGE =
  'This plugin isn’t installable offline yet — its skill content isn’t bundled with this version of SprintEngine. It may become installable after an app update refreshes the catalogue.'

/**
 * Identity of a bundled content set: a digest over the (sorted) per-skill
 * contentDigests. This is what verify pins and install re-checks — the
 * bundled analogue of the old commit-sha TOCTOU pin (bundled bytes only
 * change when the app or its catalogue update, and that must send the user
 * back through the trust prompt, not silently install different content).
 */
function bundledClaudeContentRef(contentDigests: readonly string[]): string {
  const digest = createHash('sha256')
    .update([...contentDigests].sort().join('\n'), 'utf8')
    .digest('hex')
  return `bundled:${digest.slice(0, 16)}`
}

/**
 * Stage a Claude Code plugin's installable skill content from the BUNDLED
 * catalogue payload (resources/marketplace/skills/<entryId>/), never the
 * network: the old GitHub contents-API walk needed ~2x60 unauthenticated
 * calls for a large plugin against a 60/hour cap and died mid-"Verifying…".
 * Every staged folder is verified byte-for-byte against the entry's digest
 * listing before it is offered for install; an entry whose content did not
 * ship in the snapshot gets an honest "not installable offline yet" failure.
 * Commands/agents/hooks in the plugin are NOT staged or installed; skills are
 * the one component the studio can honestly deliver today.
 */
export async function downloadClaudeCodePluginSource(
  options: ClaudeCodePluginDownloadOptions,
): Promise<ClaudeCodePluginDownloadResult> {
  const log = options.log ?? (() => undefined)
  const entry = options.entry
  const sourceUrl = entry.source?.trim() ?? ''

  const bundledSkills = (entry.skills ?? []).filter(
    (skill) => skill.files !== undefined && skill.contentDigest !== undefined && typeof skill.path === 'string',
  )
  log('claude-plugin:resolve', {
    entryId: entry.id,
    skills: entry.skills?.length ?? 0,
    bundledSkills: bundledSkills.length,
  })
  if (bundledSkills.length === 0) {
    log('claude-plugin:not-bundled', { entryId: entry.id, reason: 'entry carries no content digests' })
    return { ok: false, sourceUrl, message: CLAUDE_PLUGIN_NOT_BUNDLED_MESSAGE }
  }

  const resolveResource = options.packagedResourceResolver ?? findMarketplaceResourcePath
  const resourceDir = resolveResource(`skills/${entry.id}`)
  if (resourceDir === null) {
    log('claude-plugin:not-bundled', { entryId: entry.id, reason: 'no packaged payload dir' })
    return { ok: false, sourceUrl, message: CLAUDE_PLUGIN_NOT_BUNDLED_MESSAGE }
  }

  const stagingRoot = options.stagingRoot ?? defaultMarketplacePluginStagingRoot()
  let stage: string | null = null
  try {
    await mkdir(stagingRoot, { recursive: true })
    stage = await mkdtemp(join(stagingRoot, `${entry.id}-claude-`))
    const contentDigests: string[] = []
    const resourceRoot = resolve(resourceDir)
    const stageSkillsRoot = resolve(join(stage, 'skills'))
    for (const skill of bundledSkills) {
      // The payload folder is the basename of the skill's repo-relative path;
      // the validator guarantees a safe path on digest-bearing skills, but
      // re-derive and containment-check here so a mis-generated catalogue can
      // never make cp read or write outside the payload/staging roots.
      const folder =
        (skill.path as string)
          .split('/')
          .filter((segment) => segment.length > 0)
          .pop() ?? ''
      if (folder === '' || folder === '.' || folder === '..' || folder.includes('\\')) {
        return { ok: false, sourceUrl, message: `Skill “${skill.name}” has an unusable bundled folder path.` }
      }
      const payloadDir = resolve(resourceRoot, folder)
      const stageDir = resolve(stageSkillsRoot, folder)
      if (!payloadDir.startsWith(`${resourceRoot}${sep}`) || !stageDir.startsWith(`${stageSkillsRoot}${sep}`)) {
        return {
          ok: false,
          sourceUrl,
          message: `Skill “${skill.name}” resolves outside its bundled payload directory.`,
        }
      }
      const verification = await verifyBundledSkillFolder(payloadDir, skill.files ?? [], skill.contentDigest ?? '')
      if (!verification.ok) {
        log('claude-plugin:integrity-failure', { entryId: entry.id, skill: folder, message: verification.message })
        return {
          ok: false,
          sourceUrl,
          message: `Bundled content for skill “${skill.name}” failed integrity verification: ${verification.message} Reinstalling or updating SprintEngine restores the packaged catalogue.`,
        }
      }
      await mkdir(join(stage, 'skills'), { recursive: true })
      await cp(payloadDir, join(stage, 'skills', folder), { recursive: true })
      contentDigests.push(skill.contentDigest as string)
    }

    const skillDirs = await stagedSkillDirs(join(stage, 'skills'))
    if (skillDirs.length === 0) {
      return {
        ok: false,
        sourceUrl,
        message:
          'This Claude Code plugin bundles no skills. SprintEngine installs plugin skills only; its commands run inside Claude Code sessions.',
      }
    }

    const resolvedRef = bundledClaudeContentRef(contentDigests)
    if (options.refOverride !== undefined && options.refOverride !== resolvedRef) {
      log('claude-plugin:pin-mismatch', { entryId: entry.id, pinned: options.refOverride, actual: resolvedRef })
      return {
        ok: false,
        sourceUrl,
        message:
          'The bundled skill content changed since it was verified (the app or its catalogue updated). Review and trust the plugin again.',
      }
    }

    // Skills the entry advertises but that shipped without content (a capture
    // cap) install nothing — name them so the caller can disclose the gap
    // instead of the storefront listing a skill the user never receives.
    const bundledNames = new Set(bundledSkills.map((skill) => skill.name))
    const metadataOnlySkills = (entry.skills ?? []).map((skill) => skill.name).filter((name) => !bundledNames.has(name))
    if (metadataOnlySkills.length > 0) {
      log('claude-plugin:metadata-only-skills', { entryId: entry.id, skills: metadataOnlySkills })
    }

    log('claude-plugin:staged', { entryId: entry.id, skillDirs, resolvedRef })
    const result: ClaudeCodePluginDownloadResult = {
      ok: true,
      sourceUrl,
      stagedPath: stage,
      skillDirs,
      metadataOnlySkills,
      claudeName: entry.name,
      resolvedRef,
      pin: {
        manifestSha256: sha256Hex(Buffer.from(resolvedRef, 'utf8')),
        componentDigests: Object.fromEntries(
          bundledSkills.map((skill) => [
            `skills/${(skill.path as string).split('/').filter(Boolean).pop()}`,
            skill.contentDigest as string,
          ]),
        ),
      },
    }
    stage = null // ownership transfers to the caller, which removes it
    return result
  } catch (error) {
    log('claude-plugin:stage-failed', { entryId: entry.id, message: formatError(error) })
    return { ok: false, sourceUrl, message: formatError(error) }
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true }).catch(() => undefined)
  }
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
  limits: DownloadLimits,
): Promise<void> {
  const state: DownloadState = { files: 0, bytes: 0, dirRequests: 0 }
  const pluginUrl = source.pathname.endsWith('/plugin.json')
    ? source
    : new URL(`${ensureTrailingSlash(source.toString())}plugin.json`)
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
  state: DownloadState,
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
  maxBytes: number,
): Promise<string> {
  return (await fetchBytes(url, fetcher, timeoutMs, headers, maxBytes)).toString('utf8')
}

async function fetchBytes(
  url: string,
  fetcher: MarketplacePluginDownloadFetch,
  timeoutMs: number | undefined,
  headers: Record<string, string>,
  maxBytes: number,
): Promise<Buffer> {
  const parsed = parseHttpsUrl(url)
  if (!parsed.ok) throw new Error(parsed.message)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_MARKETPLACE_PLUGIN_DOWNLOAD_TIMEOUT_MS)
  try {
    let response: Response
    try {
      // A redirect would leave the host allowlist unchecked for wherever it
      // points; nothing this reads is expected to move.
      response = await fetcher(parsed.url.toString(), {
        method: 'GET',
        headers,
        signal: controller.signal,
        redirect: 'error',
      })
    } catch (error) {
      throw new DownloadNetworkError(`Marketplace plugin download failed. ${formatError(error)}`, parsed.url.toString())
    }
    if (!response.ok) {
      throw new DownloadHttpError(
        `Marketplace plugin download failed with HTTP ${response.status}.`,
        response.status,
        parsed.url.toString(),
      )
    }
    let arrayBuffer: ArrayBuffer
    try {
      arrayBuffer = await response.arrayBuffer()
    } catch (error) {
      throw new DownloadNetworkError(
        `Marketplace plugin download response could not be read. ${formatError(error)}`,
        parsed.url.toString(),
      )
    }
    const body = Buffer.from(arrayBuffer)
    if (body.byteLength > maxBytes) throw new Error(`Downloaded file exceeds ${maxBytes} bytes.`)
    return body
  } finally {
    clearTimeout(timeout)
  }
}

function parseGithubTreeSource(url: URL): GithubTreeSource | 'invalid' | null {
  if (url.hostname !== 'github.com') return null
  const segments = url.pathname.split('/').filter(Boolean)
  // `tree/<ref>` alone is the repository root: a bundle whose plugin.json
  // sits at the top of its own repository.
  if (segments.length < 4 || segments[2] !== 'tree') return null
  const [owner, repo, , ref] = segments
  if (!GITHUB_OWNER_PATTERN.test(owner) || !GITHUB_REPO_PATTERN.test(repo) || !GITHUB_REF_PATTERN.test(ref)) {
    return 'invalid'
  }
  return { owner, repo, ref, path: segments.slice(4).join('/') }
}

function githubCommitUrl(source: GithubTreeSource): string {
  return `https://api.github.com/repos/${source.owner}/${source.repo}/commits/${encodeURIComponent(source.ref)}`
}

// The commit a source's ref names right now — or the pinned one, which is
// used as given rather than asked about, because asking would only tell us
// where the branch has moved to since.
async function resolveGithubCommit(
  source: GithubTreeSource,
  pinned: string | undefined,
  fetcher: MarketplacePluginDownloadFetch,
  timeoutMs: number | undefined,
): Promise<string> {
  if (pinned !== undefined) {
    if (!COMMIT_SHA_PATTERN.test(pinned)) throw new Error('The pinned commit is not a commit SHA.')
    return pinned
  }
  if (COMMIT_SHA_PATTERN.test(source.ref)) return source.ref
  const body = await fetchText(
    githubCommitUrl(source),
    fetcher,
    timeoutMs,
    { accept: 'application/vnd.github.sha' },
    1024,
  )
  const sha = body.trim().toLowerCase()
  if (!COMMIT_SHA_PATTERN.test(sha)) {
    throw new Error(`GitHub did not resolve ${source.owner}/${source.repo}@${source.ref} to a commit.`)
  }
  return sha
}

// The pin a trust prompt discloses and an install re-checks: sha256 of the
// staged plugin.json, and of every other staged file by its bundle path.
async function stagedBundlePin(stage: string, commitSha: string | undefined): Promise<MarketplaceTrustPin> {
  const componentDigests: Record<string, string> = {}
  let manifestSha256 = ''
  for (const relPath of await listStagedFiles(stage)) {
    const digest = sha256Hex(await readFile(join(stage, relPath)))
    if (relPath === 'plugin.json') manifestSha256 = digest
    else componentDigests[relPath] = digest
  }
  return { ...(commitSha ? { commitSha } : {}), manifestSha256, componentDigests }
}

async function listStagedFiles(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = []
  const entries = await readdir(join(root, prefix), { withFileTypes: true })
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...(await listStagedFiles(root, relPath)))
    else if (entry.isFile()) files.push(relPath)
  }
  return files
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function githubContentsUrl(source: GithubTreeSource): string {
  const path = source.path ? `/${source.path}` : ''
  return `https://api.github.com/repos/${source.owner}/${source.repo}/contents${path}?ref=${encodeURIComponent(source.ref)}`
}

function relativeGithubPath(basePath: string, path: string | undefined): string {
  // A repo-root source (claude plugins) has basePath '' — every repo path is
  // already bundle-relative; the safety check below still applies.
  const relPath =
    basePath === ''
      ? (path ?? '')
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
  const extraHosts = parseMarketplaceExtraHosts(readStudioEnv(MARKETPLACE_EXTRA_HOSTS_ENV))
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
  constructor(
    message: string,
    readonly statusCode: number,
    readonly url: string,
  ) {
    super(message)
  }
}

class DownloadNetworkError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message)
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
