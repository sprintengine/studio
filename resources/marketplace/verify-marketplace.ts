import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { buildSync } from 'esbuild'

import {
  marketplaceAutomationPayloadIssuesSync,
  marketplaceComponentDigestMismatchIssuesSync,
} from '../../packages/module-sdk/src/plugin-component-digests'
import { normalizeMcpServerConfig } from '../../src/main/mcp-config-service'
import { readStudioEnv } from '../../src/shared/studio-env'
import { verifyBundledSkillFolder } from '../../src/main/marketplace/skill-content'
import {
  MARKETPLACE_COMPONENT_KINDS,
  MARKETPLACE_EXTRA_HOSTS_ENV,
  hasCodeBearingComponent,
  isMarketplaceSourceHostAllowed,
  parseMarketplaceExtraHosts,
  parseMarketplaceIndex,
  parseMarketplacePluginAuthoringManifest,
  parseMarketplacePluginManifest,
  type MarketplaceComponentKind,
  type MarketplaceManifestIssue,
  type MarketplacePluginAuthoringManifest,
  type MarketplacePluginEntry,
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
        console.log('Usage: node marketplace-registry-verify.cjs [--root <marketplace-root>] [--cli <sprintengine-module-cli.cjs>]')
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

function componentKinds(manifest: Pick<MarketplacePluginManifest, 'components'>): MarketplaceComponentKind[] {
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
  const outfile = join(process.cwd(), 'node_modules', '.cache', 'sprintengine', 'sprintengine-module-marketplace-ci.cjs')
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
  const extraHosts = parseMarketplaceExtraHosts(readStudioEnv(MARKETPLACE_EXTRA_HOSTS_ENV))
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
 *
 * A data URI renders offline and needs no registry base to resolve, which is
 * why the automation starters use one — but a base64 blob is unreviewable, so
 * those entries also commit the mark at `icons/<id>.svg`. When both exist they
 * must be the same bytes: otherwise the reviewed mark and the shipped mark
 * quietly diverge.
 */
function validateEntryIcon(root: string, index: number, entryId: string, icon: string, issues: VerificationIssue[]): void {
  if (icon.startsWith('data:image/')) {
    assertInlineIconMatchesCommittedMark(root, index, entryId, icon, issues)
    return
  }
  if (URL.canParse(icon) && new URL(icon).protocol === 'https:') return
  const iconPath = join(root, icon)
  if (!isInsideOrEqual(root, iconPath) || !existsSync(iconPath)) {
    issues.push(issue(`marketplace.json.plugins[${index}].icon`, `icon path "${icon}" must exist inside the registry.`))
  }
}

function assertInlineIconMatchesCommittedMark(
  root: string,
  index: number,
  entryId: string,
  icon: string,
  issues: VerificationIssue[]
): void {
  const markPath = join(root, 'icons', `${entryId}.svg`)
  if (!isInsideOrEqual(root, markPath) || !existsSync(markPath)) return
  const encoded = /^data:image\/svg\+xml;base64,(.*)$/s.exec(icon)?.[1]
  if (encoded === undefined) {
    issues.push(issue(
      `marketplace.json.plugins[${index}].icon`,
      `icons/${entryId}.svg is committed, so the entry icon must be the base64 SVG data URI of those bytes.`
    ))
    return
  }
  if (!Buffer.from(encoded, 'base64').equals(readFileSync(markPath))) {
    issues.push(issue(
      `marketplace.json.plugins[${index}].icon`,
      `inline icon does not match the committed mark at icons/${entryId}.svg.`
    ))
  }
}

/**
 * An inline-CLI entry surfaces an app-bundled agent CLI plugin as
 * marketplace content: no bundle, no bytes to download — the install action is
 * the bundled plugin's `install` spec executed by the CLI runtime installer.
 * Two rules replace the signature gate:
 *
 * - `publisher.verified` may be claimed only when the named publisher is a
 *   verified publisher in trusted-publishers.json: identity is proven by the
 *   signed app bundle the plugin ships inside, and the trust-anchor file keeps
 *   an arbitrary index entry from wearing the badge under an unknown name.
 * - The referenced bundled plugin manifest must exist. This is checkable only
 *   in the app repo, where the registry root sits beside resources/plugins;
 *   the standalone registry repo has no bundled plugin tree, so there the
 *   entry's contract is the schema plus the app-side seed-drift test
 *   (cli-entries.test.ts), which regenerates every entry from the manifests.
 */
function validateInlineCliEntry(
  root: string,
  entry: MarketplacePluginEntry,
  index: number,
  trustedPublishers: TrustedPublisher[],
  issues: VerificationIssue[]
): void {
  if (entry.cli === undefined) return
  if (entry.publisher.verified) {
    const trusted = trustedPublishers.find(
      (publisher) => publisher.verified && publisher.name === entry.publisher.name
    )
    if (!trusted) {
      issues.push(issue(
        `marketplace.json.plugins[${index}].publisher.verified`,
        'an inline-CLI entry may claim a verified publisher only under a name listed as verified in trusted-publishers.json.'
      ))
    }
  }
  const bundledPluginsRoot = join(root, '..', 'plugins')
  if (existsSync(bundledPluginsRoot)) {
    const manifestPath = join(bundledPluginsRoot, entry.cli.pluginId, 'plugin.json')
    if (!existsSync(manifestPath)) {
      issues.push(issue(
        `marketplace.json.plugins[${index}].cli.pluginId`,
        `no bundled plugin manifest at resources/plugins/${entry.cli.pluginId}/plugin.json; an inline-CLI entry must reference an app-bundled plugin.`
      ))
    }
  }
}

/**
 * Every committed plugins/<id>/ payload must be claimed by an index entry that
 * this verifier actually checked — signed entries through `sprintengine-module
 * plugin verify`, unsigned non-code-bearing entries through
 * {@link validateUnsignedPluginPayload}. The payload dir is what the
 * packaged-seed install path stages, so an unclaimed one would ship bytes
 * nothing verified.
 */
function assertNoOrphanPluginPayloads(
  root: string,
  claimedIds: Set<string>,
  issues: VerificationIssue[]
): void {
  const pluginsRoot = join(root, 'plugins')
  if (!existsSync(pluginsRoot)) return
  for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (!claimedIds.has(entry.name)) {
      issues.push(issue(
        `plugins/${entry.name}`,
        'committed plugin payload has no verified marketplace.json entry; payload dirs require one.'
      ))
    }
  }
}

/**
 * A committed payload whose entry carries no signature (the automation
 * starters, which are declarative definitions and so ship unsigned like every
 * other non-code-bearing bundle). The signature gate is replaced, not dropped:
 *
 * - the manifest must parse under the optionally-signed authoring contract;
 * - it must carry no `module`/`cli` component, mirroring the download and
 *   install gates that refuse an unsigned code-bearing bundle;
 * - its component digests must match the committed bytes, so the payload cannot
 *   drift from what the manifest declares;
 * - an automation payload must be a valid definition draft, and an MCP
 *   component must parse — the same per-kind content checks the signed path
 *   runs, so the two lanes differ only in how identity is proven.
 *
 * What a signature would additionally prove — that the bundle came from the
 * named publisher — is why an unsigned entry may not claim
 * `publisher.verified`; that rule is enforced on the entry, above.
 */
function validateUnsignedPluginPayload(
  root: string,
  pluginRoot: string,
  entry: MarketplacePluginEntry,
  index: number,
  issues: VerificationIssue[]
): void {
  const manifestPath = join(pluginRoot, 'plugin.json')
  const manifestResult = parseMarketplacePluginAuthoringManifest(readFileSync(manifestPath, 'utf8'))
  if (!manifestResult.ok) {
    issues.push(...formatValidatorIssues(`plugins/${entry.id}/plugin.json`, manifestResult.issues))
    return
  }
  const { manifest } = manifestResult
  if (manifest.signature !== undefined) {
    issues.push(issue(
      `marketplace.json.plugins[${index}].signature`,
      'committed bundle is signed but its registry entry carries no signature; publish the signature on both.'
    ))
    return
  }
  if (hasCodeBearingComponent(manifest.components)) {
    issues.push(issue(
      `plugins/${entry.id}/plugin.json`,
      'an unsigned bundle may not carry a module or cli component; sign it before publishing.'
    ))
  }
  issues.push(...formatValidatorIssues(
    `plugins/${entry.id}/plugin.json`,
    marketplaceComponentDigestMismatchIssuesSync(pluginRoot, manifest, { bytesLabel: 'committed bytes' })
  ))
  issues.push(...formatValidatorIssues(
    `plugins/${entry.id}/plugin.json`,
    marketplaceAutomationPayloadIssuesSync(pluginRoot, manifest.components)
  ))
  const mcpPath = manifest.components.mcp?.path
  if (mcpPath) validateMcpComponent(root, pluginRoot, entry.id, mcpPath, issues)
  assertEntryMatchesManifest(entry, index, manifest, issues)
}

/**
 * The registry entry restates the manifest's identity, so the two must agree —
 * a shelf that lists a different name, version, or component set than the
 * bundle installs is a lie the user cannot see.
 */
function assertEntryMatchesManifest(
  entry: MarketplacePluginEntry,
  index: number,
  manifest: MarketplacePluginAuthoringManifest,
  issues: VerificationIssue[]
): void {
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
}

// Bundled skill payloads: every digest-bearing skill must have its
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
  const claimedPayloadIds = new Set<string>()
  for (const [index, entry] of marketplace.plugins.entries()) {
    if (ids.has(entry.id)) issues.push(issue(`marketplace.json.plugins[${index}].id`, 'plugin ids must be unique.'))
    ids.add(entry.id)

    if (entry.source !== undefined) validateEntrySource(entry.id, entry.source, issues)
    validateEntryIcon(root, index, entry.id, entry.icon, issues)

    // Publisher verification is a signature claim: the fingerprint check below
    // is the only thing that binds a bundle to its named publisher, so an entry
    // with no signature has nothing to bind. Enforcing this here is also what
    // keeps stripping a signature from silently downgrading a first-party
    // bundle into the unsigned lane.
    //
    // Inline-CLI entries are the one exception: they ship no
    // downloadable bytes a signature could bind. The referenced plugin already
    // lives inside the signed app bundle and the install action executes that
    // bundled plugin's `install` spec, so the app build itself is the identity
    // proof. The claim is still gated — see validateInlineCliEntry.
    if (entry.publisher.verified && entry.signature === undefined && entry.cli === undefined) {
      issues.push(issue(
        `marketplace.json.plugins[${index}].publisher.verified`,
        'a verified publisher is proven by a signature; an unsigned entry may not claim one.'
      ))
    }

    const pluginRoot = join(root, 'plugins', entry.id)
    const pluginManifestPath = join(pluginRoot, 'plugin.json')
    const hasCommittedPayload = isInsideOrEqual(root, pluginRoot) && existsSync(pluginManifestPath)

    // Unsigned entries (source-bearing plugin references, inline-MCP configs
    // and inline-CLI entries) are legal now, and since unsigned starters shipped an
    // unsigned entry may also ship a committed bundle when nothing in it is
    // code-bearing — the automation starters do. Most reference external
    // content only and have no local manifest at all; the
    // schema/source-host/icon checks above are the whole publish contract for
    // those.
    if (entry.signature === undefined) {
      if (entry.mcp !== undefined && entry.provides.join(',') !== 'mcp') {
        issues.push(issue(`marketplace.json.plugins[${index}].provides`, "inline-MCP entries must set provides to ['mcp']."))
      }
      if (entry.cli !== undefined) {
        validateInlineCliEntry(root, entry, index, trustedPublishers, issues)
      }
      if (hasCommittedPayload) {
        claimedPayloadIds.add(entry.id)
        validateUnsignedPluginPayload(root, pluginRoot, entry, index, issues)
      }
      continue
    }

    if (!hasCommittedPayload) {
      issues.push(issue(`plugins/${entry.id}/plugin.json`, 'plugin manifest is required.'))
      continue
    }
    claimedPayloadIds.add(entry.id)

    const cliResult = runPluginVerify(cliBundle, pluginRoot)
    if (!cliResult.ok) {
      issues.push(issue(
        `plugins/${entry.id}/plugin.json`,
        `sprintengine-module plugin verify failed (exit ${cliResult.status ?? 'unknown'}): ${(cliResult.stderr || cliResult.stdout).trim()}`
      ))
      continue
    }

    const manifestResult = parseMarketplacePluginManifest(readFileSync(pluginManifestPath, 'utf8'))
    if (!manifestResult.ok) {
      issues.push(...formatValidatorIssues(`plugins/${entry.id}/plugin.json`, manifestResult.issues))
      continue
    }
    const { manifest } = manifestResult
    assertEntryMatchesManifest(entry, index, manifest, issues)
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

  assertNoOrphanPluginPayloads(root, claimedPayloadIds, issues)
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
