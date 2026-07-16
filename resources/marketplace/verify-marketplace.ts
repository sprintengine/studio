import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { buildSync } from 'esbuild'

import { normalizeMcpServerConfig } from '../../src/main/mcp-config-service'
import { verifyBundledSkillFolder } from '../../src/main/marketplace/skill-content'
import {
  MARKETPLACE_COMPONENT_KINDS,
  MARKETPLACE_EXTRA_HOSTS_ENV,
  isMarketplaceSourceHostAllowed,
  parseMarketplaceExtraHosts,
  parseMarketplaceIndex,
  parseMarketplacePluginManifest,
  type MarketplaceComponentKind,
  type MarketplaceManifestIssue,
  type MarketplacePluginManifest,
} from '../../src/shared/marketplace'

type TrustedPublisher = {
  name: string
  verified: boolean
  publicKey: string
  fingerprint: string
}

type TrustedPublishers = {
  schemaVersion: 1
  publishers: TrustedPublisher[]
}

type VerifyOptions = {
  root: string
  cli?: string
}

type VerificationIssue = {
  path: string
  message: string
}

type CliVerifyResult = {
  ok: boolean
  fingerprint?: string
  stdout: string
  stderr: string
  status: number | null
}

function parseArgs(args: string[]): VerifyOptions {
  let root: string | undefined
  let cli: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    switch (arg) {
      case '--root':
        root = args[++index]
        break
      case '--cli':
        cli = args[++index]
        break
      case '--help':
      case '-h':
        console.log('Usage: node marketplace-registry-verify.cjs [--root <marketplace-root>] [--cli <multicode-module-cli.cjs>]')
        process.exit(0)
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return {
    root: resolve(root ?? defaultMarketplaceRoot()),
    ...(cli ? { cli: resolve(cli) } : {}),
  }
}

function defaultMarketplaceRoot(): string {
  const repoSeedRoot = join(process.cwd(), 'resources', 'marketplace')
  if (existsSync(join(repoSeedRoot, 'marketplace.json'))) return repoSeedRoot
  return process.cwd()
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function issue(path: string, message: string): VerificationIssue {
  return { path, message }
}

function formatValidatorIssues(prefix: string, issues: MarketplaceManifestIssue[]): VerificationIssue[] {
  return issues.map((entry) => issue(entry.path ? `${prefix}.${entry.path}` : prefix, entry.message))
}

function isInsideOrEqual(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function componentKinds(manifest: MarketplacePluginManifest): MarketplaceComponentKind[] {
  return MARKETPLACE_COMPONENT_KINDS.filter((kind) => manifest.components[kind] !== undefined)
}

function assertNoKeyMaterial(path: string, root: string, issues: VerificationIssue[]): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) {
      assertNoKeyMaterial(child, root, issues)
      continue
    }
    if (entry.name.endsWith('.key') || entry.name.endsWith('.pem')) {
      issues.push(issue(relative(root, child), 'private key material must not be committed to the marketplace registry.'))
    }
  }
}

function ensureCliBundle(cliPath: string | undefined): string {
  if (cliPath) {
    if (!existsSync(cliPath)) throw new Error(`CLI bundle not found: ${cliPath}`)
    return cliPath
  }
  const outfile = join(process.cwd(), 'node_modules', '.cache', 'multicode', 'multicode-module-marketplace-ci.cjs')
  mkdirSync(dirname(outfile), { recursive: true })
  buildSync({
    entryPoints: [join(process.cwd(), 'packages', 'module-sdk', 'src', 'cli.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
  })
  return outfile
}

function runPluginVerify(cliBundle: string, pluginRoot: string): CliVerifyResult {
  const result = spawnSync(process.execPath, [cliBundle, 'plugin', 'verify', pluginRoot], {
    encoding: 'utf8',
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  const fingerprint = stdout.match(/Signer fingerprint:\s*([a-f0-9]+)/i)?.[1]
  return {
    ok: result.status === 0,
    ...(fingerprint ? { fingerprint } : {}),
    stdout,
    stderr,
    status: result.status,
  }
}

function readTrustedPublishers(root: string, issues: VerificationIssue[]): TrustedPublisher[] {
  const path = join(root, 'trusted-publishers.json')
  if (!existsSync(path)) return []
  try {
    const payload = readJson<TrustedPublishers>(path)
    if (payload.schemaVersion !== 1 || !Array.isArray(payload.publishers)) {
      issues.push(issue('trusted-publishers.json', 'must contain schemaVersion 1 and publishers[].'))
      return []
    }
    return payload.publishers
  } catch (error) {
    issues.push(issue('trusted-publishers.json', error instanceof Error ? error.message : 'could not parse JSON.'))
    return []
  }
}

function validateMcpComponent(
  root: string,
  pluginRoot: string,
  pluginId: string,
  componentPath: string,
  issues: VerificationIssue[]
): void {
  const path = join(pluginRoot, componentPath)
  try {
    const component = readJson<{ servers?: unknown[] }>(path)
    if (!Array.isArray(component.servers) || component.servers.length === 0) {
      issues.push(issue(`plugins/${pluginId}/${componentPath}`, 'MCP component must declare a non-empty servers[] array.'))
      return
    }
    component.servers.forEach((server, index) => {
      const normalized = normalizeMcpServerConfig(server, {
        enabled: true,
        clients: ['codex', 'claude-code'],
        scope: 'workspace',
        source: 'custom',
      })
      if (!normalized) {
        issues.push(issue(`plugins/${pluginId}/${componentPath}.servers[${index}]`, 'MCP server must normalize through the app MCP parser.'))
      }
    })
  } catch (error) {
    issues.push(issue(relative(root, path), error instanceof Error ? error.message : 'could not parse MCP component JSON.'))
  }
}

function validateEntrySource(entryId: string, source: string, issues: VerificationIssue[]): void {
  let parsed: URL
  try {
    parsed = new URL(source)
  } catch {
    issues.push(issue(`plugins.${entryId}.source`, 'source must be a valid HTTPS URL.'))
    return
  }
  if (parsed.protocol !== 'https:') {
    issues.push(issue(`plugins.${entryId}.source`, 'source must be an HTTPS URL.'))
    return
  }
  const extraHosts = parseMarketplaceExtraHosts(process.env[MARKETPLACE_EXTRA_HOSTS_ENV])
  if (!isMarketplaceSourceHostAllowed(parsed.hostname, extraHosts)) {
    issues.push(issue(
      `plugins.${entryId}.source`,
      `source host "${parsed.hostname}" is not on the marketplace allowlist.`
    ))
  }
}

/**
 * Generated/unsigned entries carry self-contained icons (data: URI or an
 * https URL); only registry-relative icon paths must resolve to a committed
 * file. A remote icon is display-only, never fetched at verify time.
 */
function validateEntryIcon(root: string, index: number, icon: string, issues: VerificationIssue[]): void {
  if (icon.startsWith('data:image/')) return
  if (URL.canParse(icon) && new URL(icon).protocol === 'https:') return
  const iconPath = join(root, icon)
  if (!isInsideOrEqual(root, iconPath) || !existsSync(iconPath)) {
    issues.push(issue(`marketplace.json.plugins[${index}].icon`, `icon path "${icon}" must exist inside the registry.`))
  }
}

/**
 * Every committed plugins/<id>/ payload must belong to a SIGNED index entry.
 * Without this sweep, stripping the signature field from an entry would
 * reclassify it as unsigned, skip the CLI verification entirely, and let a
 * tampered committed payload ship — the payload dir is what gets staged by
 * the packaged-seed install path, so its presence always demands a signature.
 */
function assertNoOrphanPluginPayloads(
  root: string,
  signedIds: Set<string>,
  issues: VerificationIssue[]
): void {
  const pluginsRoot = join(root, 'plugins')
  if (!existsSync(pluginsRoot)) return
  for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (!signedIds.has(entry.name)) {
      issues.push(issue(
        `plugins/${entry.name}`,
        'committed plugin payload has no SIGNED marketplace.json entry; payload dirs require a signed entry.'
      ))
    }
  }
}

// Bundled skill payloads (MC-1644): every digest-bearing skill must have its
// payload dir present and byte-identical to the recorded digests, and every
// payload folder must be claimed by a digest-bearing entry — a skew in either
// direction ships a broken or undisclosed offline install with a green diff.
async function validateBundledSkillPayloads(
  root: string,
  marketplace: { plugins: Array<{ id: string; skills?: Array<{ name: string; path?: string; files?: Array<{ path: string; sha256: string; size: number }>; contentDigest?: string }> }> },
  issues: VerificationIssue[]
): Promise<void> {
  const skillsRoot = join(root, 'skills')
  const claimedDirs = new Map<string, Set<string>>()
  for (const entry of marketplace.plugins) {
    const digestSkills = (entry.skills ?? []).filter((skill) => skill.files !== undefined && skill.contentDigest !== undefined)
    if (digestSkills.length === 0) continue
    const payloadRoot = join(skillsRoot, entry.id)
    if (!existsSync(payloadRoot)) {
      issues.push(issue(`skills/${entry.id}`, 'entry records skill content digests but its payload dir is missing.'))
      continue
    }
    const claimed = new Set<string>()
    claimedDirs.set(entry.id, claimed)
    for (const skill of digestSkills) {
      const folder = (skill.path ?? '').split('/').filter(Boolean).pop() ?? ''
      if (!folder) {
        issues.push(issue(`skills/${entry.id}`, `skill "${skill.name}" has no usable folder path.`))
        continue
      }
      claimed.add(folder)
      const verification = await verifyBundledSkillFolder(join(payloadRoot, folder), skill.files ?? [], skill.contentDigest ?? '')
      if (!verification.ok) {
        issues.push(issue(`skills/${entry.id}/${folder}`, `bundled payload fails digest verification: ${verification.message}`))
      }
    }
    for (const dirent of readdirSync(payloadRoot, { withFileTypes: true })) {
      if (!dirent.isDirectory()) {
        issues.push(issue(`skills/${entry.id}/${dirent.name}`, 'payload roots may contain only skill folders.'))
        continue
      }
      if (!claimed.has(dirent.name)) {
        issues.push(issue(`skills/${entry.id}/${dirent.name}`, 'payload folder is not claimed by any digest-bearing skill on its entry.'))
      }
    }
  }
  if (existsSync(skillsRoot)) {
    for (const dirent of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!dirent.isDirectory() || claimedDirs.has(dirent.name)) continue
      issues.push(issue(`skills/${dirent.name}`, 'committed skill payload has no digest-bearing marketplace.json entry.'))
    }
  }
}

async function validateMarketplace(root: string, cliBundle: string): Promise<VerificationIssue[]> {
  const issues: VerificationIssue[] = []
  const marketplacePath = join(root, 'marketplace.json')
  const trustedPublishers = readTrustedPublishers(root, issues)
  const trustedByFingerprint = new Map(trustedPublishers.map((publisher) => [publisher.fingerprint, publisher]))

  if (!existsSync(marketplacePath)) {
    return [issue('marketplace.json', 'file is required at the marketplace registry root.')]
  }

  const marketplaceResult = parseMarketplaceIndex(readFileSync(marketplacePath, 'utf8'))
  if (!marketplaceResult.ok) {
    return [...issues, ...formatValidatorIssues('marketplace.json', marketplaceResult.issues)]
  }

  const { marketplace } = marketplaceResult
  const ids = new Set<string>()
  const signedIds = new Set<string>()
  for (const [index, entry] of marketplace.plugins.entries()) {
    if (ids.has(entry.id)) issues.push(issue(`marketplace.json.plugins[${index}].id`, 'plugin ids must be unique.'))
    ids.add(entry.id)
    if (entry.signature !== undefined) signedIds.add(entry.id)

    if (entry.source !== undefined) validateEntrySource(entry.id, entry.source, issues)
    validateEntryIcon(root, index, entry.icon, issues)

    // Unsigned entries (source-bearing plugin references and inline-MCP
    // configs) are legal post-MC-1434: they reference external content, so
    // there is no local plugins/<id>/ manifest to signature-verify. The app
    // routes them through the community trust prompt; the schema/source-host/
    // icon checks above are the whole publish contract for them.
    if (entry.signature === undefined) {
      if (entry.mcp !== undefined && entry.provides.join(',') !== 'mcp') {
        issues.push(issue(`marketplace.json.plugins[${index}].provides`, "inline-MCP entries must set provides to ['mcp']."))
      }
      continue
    }

    const pluginRoot = join(root, 'plugins', entry.id)
    const pluginManifestPath = join(pluginRoot, 'plugin.json')
    if (!isInsideOrEqual(root, pluginRoot) || !existsSync(pluginManifestPath)) {
      issues.push(issue(`plugins/${entry.id}/plugin.json`, 'plugin manifest is required.'))
      continue
    }

    const cliResult = runPluginVerify(cliBundle, pluginRoot)
    if (!cliResult.ok) {
      issues.push(issue(
        `plugins/${entry.id}/plugin.json`,
        `multicode-module plugin verify failed (exit ${cliResult.status ?? 'unknown'}): ${(cliResult.stderr || cliResult.stdout).trim()}`
      ))
      continue
    }

    const manifestResult = parseMarketplacePluginManifest(readFileSync(pluginManifestPath, 'utf8'))
    if (!manifestResult.ok) {
      issues.push(...formatValidatorIssues(`plugins/${entry.id}/plugin.json`, manifestResult.issues))
      continue
    }
    const { manifest } = manifestResult
    if (entry.id !== manifest.id) issues.push(issue(`marketplace.json.plugins[${index}].id`, `expected ${manifest.id}, got ${entry.id}.`))
    if (entry.name !== manifest.displayName) {
      issues.push(issue(`marketplace.json.plugins[${index}].name`, `expected "${manifest.displayName}", got "${entry.name}".`))
    }
    if (entry.latest !== manifest.version) {
      issues.push(issue(`marketplace.json.plugins[${index}].latest`, `expected ${manifest.version}, got ${entry.latest}.`))
    }
    const provides = componentKinds(manifest)
    if (entry.provides.join(',') !== provides.join(',')) {
      issues.push(issue(`marketplace.json.plugins[${index}].provides`, `expected ${provides.join(', ')}, got ${entry.provides.join(', ')}.`))
    }
    if (JSON.stringify(entry.signature) !== JSON.stringify(manifest.signature)) {
      issues.push(issue(`marketplace.json.plugins[${index}].signature`, 'registry signature must match plugins/<id>/plugin.json signature.'))
    }

    if (entry.publisher.verified) {
      const trustedPublisher = cliResult.fingerprint ? trustedByFingerprint.get(cliResult.fingerprint) : undefined
      if (!trustedPublisher) {
        issues.push(issue(
          `marketplace.json.plugins[${index}].publisher.verified`,
          'verified publishers must sign with a fingerprint listed in trusted-publishers.json.'
        ))
      } else if (!trustedPublisher.verified || trustedPublisher.name !== entry.publisher.name) {
        issues.push(issue(
          `marketplace.json.plugins[${index}].publisher.name`,
          `verified publisher must match trusted-publishers.json entry for fingerprint ${cliResult.fingerprint}.`
        ))
      }
    }

    const mcpPath = manifest.components.mcp?.path
    if (mcpPath) validateMcpComponent(root, pluginRoot, entry.id, mcpPath, issues)
  }

  assertNoOrphanPluginPayloads(root, signedIds, issues)
  await validateBundledSkillPayloads(root, marketplace, issues)
  assertNoKeyMaterial(root, root, issues)
  return issues
}

async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2))
    const cliBundle = ensureCliBundle(options.cli)
    const issues = await validateMarketplace(options.root, cliBundle)
    if (issues.length > 0) {
      console.error(`Marketplace registry validation failed for ${options.root}:`)
      for (const entry of issues) {
        console.error(`  - ${entry.path}: ${entry.message}`)
      }
      process.exit(1)
    }
    const marketplace = parseMarketplaceIndex(readFileSync(join(options.root, 'marketplace.json'), 'utf8'))
    const count = marketplace.ok ? marketplace.marketplace.plugins.length : 0
    console.log(`marketplace registry verified (${count} plugins)`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
