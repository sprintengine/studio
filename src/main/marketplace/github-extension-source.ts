import { createHash } from 'node:crypto'

import type {
  GithubExtensionOrigin,
  GithubExtensionReviewChange,
  MarketplaceMcpServerDisclosure,
  MarketplacePluginVerifyResult,
} from '../../shared/electron-api'
import type {
  MarketplaceManifestIssue,
  MarketplacePluginAuthoringManifest,
  MarketplacePluginEntry,
} from '../../shared/marketplace'
import {
  MARKETPLACE_COMPONENT_KINDS,
  MARKETPLACE_EXTRA_HOSTS_ENV,
  isMarketplaceSourceHostAllowed,
  parseMarketplaceExtraHosts,
  resolveOptionallySignedManifest,
} from '../../shared/marketplace'
import { readStudioEnv } from '../../shared/studio-env'
import { isSignedByTrustedPublisher, type ModuleTrustContext } from '../modules/module-signature'
import type { MarketplacePluginDownloadFetch } from './plugin-download'

// "Install extension from GitHub…": any repository a person pastes, as long as
// it carries a SprintEngine plugin.json (the SDK's bundle manifest) at the
// root — or at the path the URL names. This file turns the URL into a
// registry-shaped entry pinned to one commit, so the rest of the way is the
// marketplace's own: verify reads and discloses it (plugin-verify.ts), a trust
// token carries it (trust-tokens.ts), and the lifecycle installs it at that
// commit and nothing else (plugin-lifecycle.ts).
//
// The default branch is resolved to a commit here, once, and every read after
// it is at that commit: a push between the review and the click installs
// nothing rather than something nobody reviewed.

export type GithubExtensionUrl = {
  owner: string
  repo: string
  // A branch, tag or commit the URL named (`/tree/<ref>`); absent means the
  // repository's default branch.
  ref?: string
  // Where plugin.json sits in the repository; '' is the root.
  path: string
}

const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/
const GITHUB_REF_PATTERN = /^(?!-)[A-Za-z0-9._-]{1,255}$/
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/
const PATH_SEGMENT_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_API_RESPONSE_BYTES = 1024 * 1024

/**
 * A GitHub repository URL as a person might paste it — `https://github.com/o/r`,
 * `github.com/o/r.git`, `git@github.com:o/r.git`, `o/r`, or a `/tree/<ref>/<path>`
 * link to a folder — or null when it names nothing installable (another host,
 * a file, an issue). A ref containing `/` cannot be told apart from a path in
 * a tree URL, so a ref is one segment.
 */
export function parseGithubExtensionUrl(input: string): GithubExtensionUrl | null {
  const value = typeof input === 'string' ? input.trim() : ''
  if (!value || value.length > 2048) return null
  let segments: string[]
  const scp = /^git@github\.com:(.+)$/.exec(value)
  if (scp) {
    segments = scp[1]!.split('/')
  } else if (/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(value)) {
    segments = value.split('/')
  } else {
    let url: URL
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`)
    } catch {
      return null
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    const host = url.hostname.toLowerCase()
    if (host !== 'github.com' && host !== 'www.github.com') return null
    if (url.username || url.password || url.port) return null
    segments = url.pathname.split('/')
  }
  segments = segments.filter((segment) => segment.length > 0)
  if (segments.length < 2) return null
  const owner = segments[0]!
  const repo = segments[1]!.replace(/\.git$/, '')
  if (!GITHUB_OWNER_PATTERN.test(owner) || !GITHUB_REPO_PATTERN.test(repo)) return null
  if (segments.length === 2) return { owner, repo, path: '' }
  if (segments[2] !== 'tree' || segments.length < 4) return null
  const ref = segments[3]!
  if (!GITHUB_REF_PATTERN.test(ref)) return null
  const pathSegments = segments.slice(4)
  if (!pathSegments.every((segment) => PATH_SEGMENT_PATTERN.test(segment))) return null
  return { owner, repo, ref, path: pathSegments.join('/') }
}

/** The repository as a URL again, normalised: what a receipt records and an update re-reads. */
export function githubExtensionOrigin(parsed: GithubExtensionUrl): GithubExtensionOrigin {
  const base = `https://github.com/${parsed.owner}/${parsed.repo}`
  const tree = parsed.ref ? `/tree/${parsed.ref}${parsed.path ? `/${parsed.path}` : ''}` : ''
  return {
    url: `${base}${tree}`,
    owner: parsed.owner,
    repo: parsed.repo,
    ...(parsed.ref ? { ref: parsed.ref } : {}),
  }
}

export type ResolveGithubExtensionDeps = {
  trustContext: () => ModuleTrustContext
  fetcher?: MarketplacePluginDownloadFetch
  timeoutMs?: number
}

export type ResolvedGithubExtension = {
  ok: true
  entry: MarketplacePluginEntry
  sha: string
  origin: GithubExtensionOrigin
  manifest: MarketplacePluginAuthoringManifest
}

export type GithubExtensionResolveFailure = {
  ok: false
  message: string
  issues?: MarketplaceManifestIssue[]
  // The repository is an agent-CLI plugin (`.claude-plugin/`): a skill source,
  // added from the Skills path, which this does not change.
  skillSource?: boolean
}

export const CLAUDE_PLUGIN_REPOSITORY_MESSAGE =
  'This repository is an agent-CLI plugin (it has .claude-plugin/), not a SprintEngine extension. ' +
  'Add it as a skill source instead: Extensions → Skills → + → “Add skill source from GitHub…”.'

/**
 * Resolve a pasted URL to an entry pinned to one commit: the ref (the default
 * branch unless the URL named one) → its commit → the listing at that commit →
 * plugin.json at that commit → a registry-shaped entry whose source is
 * `https://github.com/<o>/<r>/tree/<sha>[/<path>]`. Nothing is downloaded
 * beyond plugin.json; verify reads the components.
 */
export async function resolveGithubExtension(
  url: string,
  deps: ResolveGithubExtensionDeps,
): Promise<ResolvedGithubExtension | GithubExtensionResolveFailure> {
  const parsed = parseGithubExtensionUrl(url)
  if (!parsed) {
    return {
      ok: false,
      message: 'That is not a GitHub repository URL. Paste one like https://github.com/owner/repo.',
    }
  }
  const request = (target: string, accept: string) => fetchGithub(target, accept, deps)
  const label = `${parsed.owner}/${parsed.repo}`
  const api = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`

  try {
    let ref = parsed.ref
    if (!ref) {
      const repository = await request(api, 'application/vnd.github+json')
      if (repository.status === 404) {
        return { ok: false, message: `GitHub has no public repository ${label}.` }
      }
      if (!repository.ok) return { ok: false, message: httpFailure(label, repository.status) }
      const defaultBranch = jsonField(repository.body, 'default_branch')
      if (!defaultBranch || !GITHUB_REF_PATTERN.test(defaultBranch)) {
        return { ok: false, message: `GitHub did not say which branch ${label} installs from.` }
      }
      ref = defaultBranch
    }

    let sha: string
    if (COMMIT_SHA_PATTERN.test(ref)) {
      sha = ref
    } else {
      const commit = await request(`${api}/commits/${encodeURIComponent(ref)}`, 'application/vnd.github.sha')
      if (commit.status === 404 || commit.status === 422) {
        return { ok: false, message: `${label} has no branch, tag or commit named “${ref}”.` }
      }
      if (!commit.ok) return { ok: false, message: httpFailure(label, commit.status) }
      sha = commit.body.trim().toLowerCase()
      if (!COMMIT_SHA_PATTERN.test(sha)) {
        return { ok: false, message: `GitHub did not resolve ${label}@${ref} to a commit.` }
      }
    }

    const where = parsed.path ? `/${parsed.path}` : ''
    const listing = await request(`${api}/contents${where}?ref=${sha}`, 'application/vnd.github+json')
    if (listing.status === 404) {
      return { ok: false, message: `${label} has no folder “${parsed.path}” at ${sha.slice(0, 7)}.` }
    }
    if (!listing.ok) return { ok: false, message: httpFailure(label, listing.status) }
    const entries = contentsEntries(listing.body)
    const pluginJson = entries.find((entry) => entry.name === 'plugin.json' && entry.type === 'file')
    if (!pluginJson) {
      if (entries.some((entry) => entry.name === '.claude-plugin' && entry.type === 'dir')) {
        return { ok: false, message: CLAUDE_PLUGIN_REPOSITORY_MESSAGE, skillSource: true }
      }
      return {
        ok: false,
        message:
          `${label} has no plugin.json ${parsed.path ? `in ${parsed.path}` : 'at its root'}, so it is not a ` +
          'SprintEngine extension. An extension repository keeps plugin.json at the top, naming its module/ folder.',
      }
    }
    if (!pluginJson.download_url || !isAllowedHost(pluginJson.download_url)) {
      return { ok: false, message: `GitHub did not offer a download for ${label}’s plugin.json.` }
    }
    const manifestSource = await request(pluginJson.download_url, '*/*')
    if (!manifestSource.ok) return { ok: false, message: httpFailure(label, manifestSource.status) }

    if (namesAgentCli(manifestSource.body)) {
      return {
        ok: false,
        message:
          'This plugin.json describes an agent CLI. Agent CLIs ship with SprintEngine Studio and cannot be installed.',
      }
    }
    const resolved = resolveOptionallySignedManifest(manifestSource.body)
    if (!resolved.ok) {
      return {
        ok: false,
        message: `${label}’s plugin.json is not a valid SprintEngine plugin manifest.`,
        issues: resolved.issues,
      }
    }
    const manifest = resolved.manifest
    const origin = githubExtensionOrigin(parsed)
    const entry: MarketplacePluginEntry = {
      id: manifest.id,
      name: manifest.displayName,
      publisher: {
        name: manifest.publisher?.trim() || parsed.owner,
        // A "verified" badge means a key this app trusts signed it — the same
        // rule the registry's verified tier is held to at download.
        verified: isSignedByTrustedPublisher(manifest, deps.trustContext()),
      },
      summary: manifest.summary?.trim() || `${manifest.displayName}, from ${label}.`,
      category: manifest.category?.trim() || 'Extension',
      icon: 'github',
      latest: manifest.version,
      provides: MARKETPLACE_COMPONENT_KINDS.filter((kind) => manifest.components[kind] !== undefined),
      source: `https://github.com/${parsed.owner}/${parsed.repo}/tree/${sha}${where}`,
      ...(manifest.signature ? { signature: manifest.signature } : {}),
    }
    return { ok: true, entry, sha, origin, manifest }
  } catch (error) {
    return { ok: false, message: `Could not read ${label} from GitHub. ${formatError(error)}` }
  }
}

// ---------------------------------------------------------------------------
// What changed since the last approval
// ---------------------------------------------------------------------------

/**
 * The digest of an MCP disclosure, order-independent: what a receipt records
 * so an update can tell whether the servers it would write changed, without
 * keeping their command lines around.
 */
export function mcpDisclosureDigest(servers: readonly MarketplaceMcpServerDisclosure[] | undefined): string {
  const canonical = [...(servers ?? [])]
    .map((server) => JSON.stringify(server, Object.keys(server).sort()))
    .sort()
    .join('\n')
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export type ApprovedDisclosure = {
  permissions?: readonly string[]
  mcpDigest?: string
  classification: 'verified' | 'community' | 'unsigned'
  source?: { kind: 'registry' } | { kind: 'github'; owner: string; repo: string }
}

/**
 * What a fresh review discloses that the last approval did not cover. An
 * update whose list is empty goes ahead on the approval already given; any
 * entry sends it back to the person. A receipt too old to say (no recorded
 * permissions or MCP digest) counts as changed: nothing can show the person
 * saw it.
 */
export function githubReviewChanges(
  approved: ApprovedDisclosure,
  next: Pick<MarketplacePluginVerifyResult, 'permissions' | 'mcpServers' | 'classification'>,
  origin: Pick<GithubExtensionOrigin, 'owner' | 'repo'>,
): GithubExtensionReviewChange[] {
  const changes: GithubExtensionReviewChange[] = []
  const before = approved.permissions ? [...approved.permissions].sort().join('\n') : null
  if (before === null || before !== [...next.permissions].sort().join('\n')) changes.push('permissions')
  if (approved.mcpDigest === undefined || approved.mcpDigest !== mcpDisclosureDigest(next.mcpServers)) {
    changes.push('mcp')
  }
  if (approved.classification !== next.classification) changes.push('classification')
  const source = approved.source
  if (
    source?.kind !== 'github' ||
    source.owner.toLowerCase() !== origin.owner.toLowerCase() ||
    source.repo.toLowerCase() !== origin.repo.toLowerCase()
  ) {
    changes.push('source')
  }
  return changes
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

type GithubResponse = { ok: boolean; status: number; body: string }

async function fetchGithub(url: string, accept: string, deps: ResolveGithubExtensionDeps): Promise<GithubResponse> {
  if (!isAllowedHost(url)) throw new Error(`${new URL(url).hostname} is not a GitHub host.`)
  const fetcher = deps.fetcher ?? defaultFetch
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    // A redirect would leave the host check behind for wherever it points.
    const response = await fetcher(url, {
      method: 'GET',
      headers: { accept },
      signal: controller.signal,
      redirect: 'error',
    })
    if (!response.ok) return { ok: false, status: response.status, body: '' }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > MAX_API_RESPONSE_BYTES) throw new Error('GitHub answered with more than expected.')
    return { ok: true, status: response.status, body: bytes.toString('utf8') }
  } finally {
    clearTimeout(timeout)
  }
}

function isAllowedHost(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const extraHosts = parseMarketplaceExtraHosts(readStudioEnv(MARKETPLACE_EXTRA_HOSTS_ENV))
  return parsed.protocol === 'https:' && isMarketplaceSourceHostAllowed(parsed.hostname, extraHosts)
}

function httpFailure(label: string, status: number): string {
  if (status === 403 || status === 429) {
    return `GitHub refused to answer for ${label} right now (HTTP ${status}) — its rate limit for this machine may be used up. Try again later.`
  }
  return `GitHub answered HTTP ${status} for ${label}.`
}

type ContentsEntry = { name?: string; type?: string; download_url?: string | null }

function contentsEntries(body: string): ContentsEntry[] {
  try {
    const parsed = JSON.parse(body) as unknown
    return Array.isArray(parsed) ? (parsed as ContentsEntry[]) : []
  } catch {
    return []
  }
}

function jsonField(body: string, field: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const value = parsed?.[field]
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

function namesAgentCli(source: string): boolean {
  try {
    const parsed = JSON.parse(source) as { components?: Record<string, unknown> }
    return typeof parsed?.components === 'object' && parsed.components !== null && 'cli' in parsed.components
  } catch {
    return false
  }
}

async function defaultFetch(url: string, init: RequestInit): Promise<Response> {
  if (typeof globalThis.fetch !== 'function') throw new Error('fetch is not available in this runtime.')
  return globalThis.fetch(url, init)
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
