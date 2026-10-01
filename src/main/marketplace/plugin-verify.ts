import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  MarketplaceManifestIssue,
  MarketplacePluginAuthoringManifest,
  MarketplacePluginEntry,
} from '../../shared/marketplace'
import { hasCodeBearingComponent, isClaudeCodePluginEntry, validateMarketplaceIndex } from '../../shared/marketplace'
import type {
  MarketplaceMcpServerDisclosure,
  MarketplacePluginVerifyResult,
  MarketplaceTrustPin,
  McpServerConfig,
} from '../../shared/electron-api'
import type { CapabilityPermission } from '../../shared/modules/permissions'
import { normalizeMcpServerConfig } from '../mcp-config-service'
import { validateModuleFileDigests } from '../../../packages/module-sdk/src/manifest-validate'
import { parseThirdPartyModuleManifest } from '../../shared/modules/third-party-manifest'
import { moduleFileDigestIssuesSync, type ModuleTrustContext } from '../modules/module-signature'
import { readBundleMcpServers } from '../modules/plugin-bundle-installer'
import {
  defaultMarketplacePluginStagingRoot,
  downloadClaudeCodePluginSource,
  downloadMarketplacePluginBundle,
  type MarketplaceInstallLog,
  type MarketplacePluginDownloadFetch,
} from './plugin-download'
import type { MarketplaceResourceResolver } from './resources'

export type MarketplacePluginVerifierServices = {
  trustContext: () => ModuleTrustContext
  stagingRoot?: string
  fetcher?: MarketplacePluginDownloadFetch
  /** Test seam for packaged resource resolution (bundled claude-plugin skills). */
  packagedResourceResolver?: MarketplaceResourceResolver
  log?: MarketplaceInstallLog
}

export type MarketplacePluginVerifyOptions = {
  // An unsigned bundle carrying module code is read and disclosed rather than
  // refused — for a GitHub-URL install, where the person may then choose to
  // trust the code. Never set on the registry path.
  allowUnsignedCode?: boolean
  // Refuse a module component whose own manifest lists no `files` digests, or
  // whose files do not match them. The digests are what module trust holds
  // the installed code to at every launch; without them a person could be
  // asked to trust code nothing would ever check again. Set for a GitHub-URL
  // install, where nobody else has vouched for the bundle.
  requireModuleFileDigests?: boolean
}

/**
 * Verify reads what an install would put on this machine — without installing
 * it — and answers with everything a trust prompt must disclose and the pin
 * that binds an install to exactly that. It takes an entry main resolved
 * itself; it does not issue the trust token (the caller does, knowing where
 * the entry came from), and the result it returns carries none.
 */
export function createMarketplacePluginVerifier(services: MarketplacePluginVerifierServices) {
  return {
    verify: (
      entry: MarketplacePluginEntry,
      options: MarketplacePluginVerifyOptions = {},
    ): Promise<MarketplacePluginVerifyResult> => verifyMarketplacePlugin(entry, services, options),
  }
}

async function verifyMarketplacePlugin(
  entry: MarketplacePluginEntry,
  services: MarketplacePluginVerifierServices,
  options: MarketplacePluginVerifyOptions,
): Promise<MarketplacePluginVerifyResult> {
  const registryEntry = validateRegistryEntry(entry)
  if (!registryEntry.ok) {
    return {
      classification: 'invalid',
      permissions: [],
      sourceUrl: sourceUrlFromEntry(entry),
      issues: registryEntry.issues,
      message: registryEntry.message,
    }
  }

  // An inline-MCP entry's servers ARE its content: there is nothing to
  // download, and the disclosure is the servers exactly as they would be
  // written. Its pin is a digest of that list.
  if (registryEntry.entry.mcp) {
    const servers = inlineMcpServers(registryEntry.entry)
    return {
      classification: 'unsigned',
      permissions: [],
      sourceUrl: '',
      mcpServers: servers.map(describeMcpServer),
      pin: inlineMcpTrustPin(registryEntry.entry),
    }
  }

  // Claude Code plugins are unsigned by nature (no studio manifest to
  // verify); the pre-trust staging exists to disclose the REAL skill file
  // listing at the trust prompt — never a fabricated one. Content resolves
  // from the bundled catalogue payload and is digest-checked, so this is
  // local file reads: near-instant, zero network.
  if (isClaudeCodePluginEntry(registryEntry.entry)) {
    services.log?.('claude-plugin:verify-start', { entryId: registryEntry.entry.id })
    const claude = await downloadClaudeCodePluginSource({
      entry: registryEntry.entry,
      stagingRoot: services.stagingRoot ?? defaultMarketplacePluginStagingRoot(),
      packagedResourceResolver: services.packagedResourceResolver,
      log: services.log,
    })
    if (!claude.ok) {
      services.log?.('claude-plugin:verify-failed', { entryId: registryEntry.entry.id, message: claude.message })
      return {
        classification: 'invalid',
        permissions: [],
        sourceUrl: claude.sourceUrl,
        issues: [{ path: 'source', message: claude.message }],
        message: claude.message,
      }
    }
    try {
      services.log?.('claude-plugin:verify-ok', { entryId: registryEntry.entry.id, files: claude.skillDirs.length })
      return {
        classification: 'unsigned',
        permissions: [],
        sourceUrl: claude.sourceUrl,
        files: claude.skillDirs.map((dir) => `skills/${dir}`),
        // The bundled-content identity this listing came from; the install
        // re-checks exactly this pin so a catalogue/app update cannot swap
        // content between the trust grant and the install.
        pin: claude.pin,
      }
    } finally {
      await rm(claude.stagedPath, { recursive: true, force: true })
    }
  }

  const download = await downloadMarketplacePluginBundle({
    entry: registryEntry.entry,
    trustContext: services.trustContext(),
    stagingRoot: services.stagingRoot ?? defaultMarketplacePluginStagingRoot(),
    fetcher: services.fetcher,
    ...(options.allowUnsignedCode ? { allowUnsignedCode: true } : {}),
  })

  if (!download.ok) {
    return {
      classification: download.classification ?? 'invalid',
      permissions: [],
      sourceUrl: download.sourceUrl,
      issues: download.issues ?? [{ path: 'source', message: download.message }],
      message: download.message,
    }
  }

  try {
    if (options.requireModuleFileDigests) {
      const problem = await moduleFileDigestProblem(download.stagedBundlePath, download.manifest)
      if (problem) {
        return {
          classification: 'invalid',
          permissions: [],
          sourceUrl: download.sourceUrl,
          issues: problem.issues,
          message: problem.message,
        }
      }
    }
    const servers = await bundleMcpDisclosure(download.stagedBundlePath, download.manifest)
    return {
      classification: download.classification,
      permissions: [...((download.manifest.permissions ?? []) as CapabilityPermission[])],
      sourceUrl: download.sourceUrl,
      ...(servers.length > 0 ? { mcpServers: servers } : {}),
      ...(hasCodeBearingComponent(download.manifest.components) ? { codeBearing: true } : {}),
      ...(download.trust.fingerprint ? { keyFingerprint: download.trust.fingerprint } : {}),
      pin: download.pin,
    }
  } finally {
    await rm(download.stagedBundlePath, { recursive: true, force: true })
  }
}

// Every MCP server a staged bundle would add, as the prompt discloses it. The
// lifecycle reads the same list off what it installs, so a receipt can say
// what was approved.
export async function bundleMcpDisclosure(
  stage: string,
  manifest: MarketplacePluginAuthoringManifest,
): Promise<MarketplaceMcpServerDisclosure[]> {
  return (await readBundleMcpServers(stage, manifest)).map(describeMcpServer)
}

// What is wrong with a staged bundle's module component as code to trust: its
// manifest does not parse, lists no `files`, or its folder does not hold
// exactly those files. Null when there is no module, or nothing is wrong.
async function moduleFileDigestProblem(
  stage: string,
  manifest: MarketplacePluginAuthoringManifest,
): Promise<{ message: string; issues: MarketplaceManifestIssue[] } | null> {
  const component = manifest.components.module
  if (!component) return null
  const moduleRoot = join(stage, component.path)
  let source: string
  try {
    source = await readFile(join(moduleRoot, 'manifest.json'), 'utf8')
  } catch {
    return {
      message: `The module folder "${component.path}" has no manifest.json.`,
      issues: [{ path: 'components.module.path', message: 'manifest.json is missing.' }],
    }
  }
  const parsed = parseThirdPartyModuleManifest(source)
  if (!parsed.ok) return { message: 'The module’s manifest.json is invalid.', issues: parsed.issues }
  const files = parsed.manifest.files
  if (!files) {
    return {
      message:
        `The module "${parsed.manifest.id}" lists no digests of its files, so nothing could hold the installed ` +
        'code to what you review here. Its author must record them with `sprintengine-module sign` (or a ' +
        `template's \`npm run dev:install\`) and commit ${component.path}/manifest.json.`,
      issues: [{ path: 'files', message: 'the module manifest carries no "files" digests.' }],
    }
  }
  const shape = validateModuleFileDigests(files)
  if (!shape.ok) return { message: 'The module’s "files" digests are malformed.', issues: shape.issues }
  const drift = moduleFileDigestIssuesSync(moduleRoot, shape.files, { label: 'the module manifest’s digests' })
  if (drift.length > 0) {
    return {
      message:
        `The module "${parsed.manifest.id}" does not match the file digests its manifest lists — ` +
        'it was changed after they were recorded. Its author must record them again and push.',
      issues: drift,
    }
  }
  return null
}

function validateRegistryEntry(
  entry: MarketplacePluginEntry,
): { ok: true; entry: MarketplacePluginEntry } | { ok: false; message: string; issues: MarketplaceManifestIssue[] } {
  const result = validateMarketplaceIndex({ schemaVersion: 1, plugins: [entry] })
  if (!result.ok) {
    return {
      ok: false,
      message: 'Marketplace plugin registry entry is invalid.',
      issues: result.issues,
    }
  }
  const validated = result.marketplace.plugins[0]
  if (!validated) {
    return {
      ok: false,
      message: 'Marketplace plugin registry entry is invalid.',
      issues: [{ path: 'entry', message: 'entry is required.' }],
    }
  }
  return { ok: true, entry: validated }
}

function sourceUrlFromEntry(entry: MarketplacePluginEntry): string {
  return typeof entry?.source === 'string' ? entry.source.trim() : ''
}

// An inline entry's servers through the app's own MCP parser — the same one
// the install writes through, so what is disclosed is what is written.
function inlineMcpServers(entry: MarketplacePluginEntry): McpServerConfig[] {
  return (entry.mcp?.servers ?? []).flatMap((raw) => {
    const server = normalizeMcpServerConfig(raw, { enabled: true, scope: 'workspace', source: 'custom' })
    return server ? [server] : []
  })
}

// The pin of an inline entry: its server list as the registry states it.
export function inlineMcpTrustPin(entry: MarketplacePluginEntry): MarketplaceTrustPin {
  const manifestSha256 = createHash('sha256')
    .update(JSON.stringify(entry.mcp?.servers ?? []), 'utf8')
    .digest('hex')
  return { manifestSha256, componentDigests: {} }
}

function describeMcpServer(server: McpServerConfig): MarketplaceMcpServerDisclosure {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    ...(server.command ? { command: server.command } : {}),
    args: [...(server.args ?? [])],
    ...(server.url ? { url: server.url } : {}),
    envKeys: [...new Set([...Object.keys(server.env ?? {}), ...(server.envVarNames ?? [])])].sort(),
    headerKeys: Object.keys(server.headers ?? {}).sort(),
  }
}
