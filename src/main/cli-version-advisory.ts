// Is an installed agent CLI behind the version its registry publishes?
// Ask npm for `latest`, compare loosely to what `--version` printed, and name
// the command that would update it. Loosely, because a CLI is free to print a
// build suffix or a `v` prefix that the registry version does not carry, and a
// false "you are behind" is worse than no advisory at all.
//
// Pure apart from the fetcher, which is injected. The registry answer is cached
// in memory for an hour per package so a focus-driven availability refresh
// never re-asks npm. A registry that does not answer within the timeout yields
// `unknown`, never a failure that could block availability detection.
import type { CliAvailability, CliUpdateCommand, CliVersionAdvisory, CliVersionAdvisoryMap } from '../shared/electron-api'
import type { PluginManifest } from '../shared/plugin-manifest'
import { compareSemver } from '../shared/semver'

const NPM_LATEST_CACHE_TTL_MS = 60 * 60 * 1_000
const NPM_LATEST_TIMEOUT_MS = 4_000

export type NpmLatestFetch = (url: string, init: RequestInit) => Promise<Response>

type CacheEntry = { version: string | null; expiresAt: number }
const npmLatestCache = new Map<string, CacheEntry>()

export function clearNpmLatestCache(): void {
  npmLatestCache.clear()
}

export async function fetchNpmLatestVersion(
  packageName: string,
  deps: { fetcher?: NpmLatestFetch; now?: () => number; timeoutMs?: number; force?: boolean } = {},
): Promise<string | null> {
  const now = deps.now ?? Date.now
  const cached = npmLatestCache.get(packageName)
  if (!deps.force && cached && cached.expiresAt > now()) return cached.version

  const fetcher = deps.fetcher ?? defaultFetch
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), deps.timeoutMs ?? NPM_LATEST_TIMEOUT_MS)
  let version: string | null = null
  try {
    const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (response.ok) {
      const payload = (await response.json()) as { version?: unknown }
      version = typeof payload.version === 'string' && payload.version.trim() ? payload.version.trim() : null
    }
  } catch {
    version = null
  } finally {
    clearTimeout(timeout)
  }
  // A miss is cached too: an unreachable registry is asked once an hour, not
  // once per refresh.
  npmLatestCache.set(packageName, { version, expiresAt: now() + NPM_LATEST_CACHE_TTL_MS })
  return version
}

export function deriveCliVersionStatus(
  currentVersion: string | null,
  latestVersion: string | null,
): CliVersionAdvisory['status'] {
  const compared = compareSemver(currentVersion, latestVersion)
  if (compared === null) return 'unknown'
  return compared < 0 ? 'behind_latest' : 'current'
}

// Homebrew installs land under its prefix (Cellar/Caskroom or the linked bin);
// a binary there is upgraded with brew, not with npm.
export function isHomebrewPath(path: string | null | undefined): boolean {
  if (!path) return false
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  return (
    normalized.includes('/homebrew/cellar/') ||
    normalized.includes('/homebrew/caskroom/') ||
    normalized.startsWith('/opt/homebrew/bin/') ||
    normalized.startsWith('/usr/local/cellar/') ||
    normalized.startsWith('/home/linuxbrew/.linuxbrew/')
  )
}

// The update the button runs, in precedence order: the CLI's own updater when the
// manifest declares one, `brew upgrade` when the binary lives under Homebrew
// and a formula is known, `npm install -g` when an npm package is known, else
// nothing here (updateCli falls back to re-running the install method).
export function chooseCliUpdateCommand(input: {
  manifest: Pick<PluginManifest, 'binary' | 'update' | 'package'>
  resolvedPath: string | null | undefined
}): CliUpdateCommand | null {
  const { manifest, resolvedPath } = input
  if (manifest.update?.args?.length) {
    return { kind: 'cli-updater', command: [manifest.binary, ...manifest.update.args].join(' ') }
  }
  if (manifest.package?.brew && isHomebrewPath(resolvedPath)) {
    return { kind: 'brew', command: `brew upgrade ${manifest.package.brew}` }
  }
  if (manifest.package?.npm) {
    return { kind: 'npm', command: `npm install -g ${manifest.package.npm}@latest` }
  }
  return null
}

export type ResolveCliVersionAdvisoriesDeps = {
  getManifest: (cli: string) => PluginManifest | null | undefined
  fetchLatest?: (packageName: string, force: boolean) => Promise<string | null>
  now?: () => Date
  force?: boolean
}

// One advisory per CLI in the availability map. Only an installed CLI with a
// version and an npm package is asked about; everything else is `unknown`
// with the update command still named, so Settings can offer Update either way.
export async function resolveCliVersionAdvisories(
  availability: Partial<Record<string, CliAvailability>>,
  deps: ResolveCliVersionAdvisoriesDeps,
): Promise<CliVersionAdvisoryMap> {
  const fetchLatest = deps.fetchLatest ?? ((pkg, force) => fetchNpmLatestVersion(pkg, { force }))
  const now = deps.now ?? (() => new Date())
  const force = deps.force ?? false
  const out: CliVersionAdvisoryMap = {}
  await Promise.all(
    Object.values(availability).map(async (entry) => {
      if (!entry) return
      const manifest = deps.getManifest(entry.cli)
      const updateCommand = manifest ? chooseCliUpdateCommand({ manifest, resolvedPath: entry.resolvedPath }) : null
      const packageName = manifest?.package?.npm ?? null
      const currentVersion = entry.version?.trim() || null
      const latestVersion =
        entry.installed && currentVersion && packageName ? await fetchLatest(packageName, force) : null
      out[entry.cli] = {
        cli: entry.cli,
        status: entry.installed ? deriveCliVersionStatus(currentVersion, latestVersion) : 'unknown',
        currentVersion,
        latestVersion,
        updateCommand,
        checkedAt: now().toISOString(),
      }
    }),
  )
  return out
}

// Which CLIs are behind, in a stable order, for the toast and the bell row.
export function outdatedClis(advisories: CliVersionAdvisoryMap): CliVersionAdvisory[] {
  return Object.values(advisories)
    .filter((entry): entry is CliVersionAdvisory => !!entry && entry.status === 'behind_latest')
    .sort((a, b) => a.cli.localeCompare(b.cli))
}

async function defaultFetch(url: string, init: RequestInit): Promise<Response> {
  if (typeof globalThis.fetch !== 'function') throw new Error('fetch is not available in this runtime.')
  return globalThis.fetch(url, init)
}
