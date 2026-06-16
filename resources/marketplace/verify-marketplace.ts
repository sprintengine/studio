import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { buildSync } from 'esbuild'

import { normalizeMcpServerConfig } from '../../src/main/mcp-config-service'
import {
  MARKETPLACE_COMPONENT_KINDS,
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
  try {
    const parsed = new URL(source)
    if (parsed.protocol !== 'https:') {
      issues.push(issue(`plugins.${entryId}.source`, 'source must be an HTTPS URL.'))
    }
  } catch {
    issues.push(issue(`plugins.${entryId}.source`, 'source must be a valid HTTPS URL.'))
  }
}

function validateMarketplace(root: string, cliBundle: string): VerificationIssue[] {
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
  for (const [index, entry] of marketplace.plugins.entries()) {
    if (ids.has(entry.id)) issues.push(issue(`marketplace.json.plugins[${index}].id`, 'plugin ids must be unique.'))
    ids.add(entry.id)

    validateEntrySource(entry.id, entry.source, issues)

    const iconPath = join(root, entry.icon)
    if (!isInsideOrEqual(root, iconPath) || !existsSync(iconPath)) {
      issues.push(issue(`marketplace.json.plugins[${index}].icon`, `icon path "${entry.icon}" must exist inside the registry.`))
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

  assertNoKeyMaterial(root, root, issues)
  return issues
}

function main(): void {
  try {
    const options = parseArgs(process.argv.slice(2))
    const cliBundle = ensureCliBundle(options.cli)
    const issues = validateMarketplace(options.root, cliBundle)
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

main()
