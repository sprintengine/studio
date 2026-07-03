import { readFile, realpath, stat } from 'fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'path'

import type {
  MarketplacePluginInstallInput,
  MarketplacePluginInstallResult,
  MarketplacePluginInstalledComponent,
  McpClientTarget,
  McpServerConfig,
  McpSettings,
  McpSyncTarget,
  McpValidationIssue,
  SkillPackHarness,
} from '../../shared/electron-api'
import type {
  MarketplaceComponentKind,
  MarketplaceManifestIssue,
  MarketplacePluginAuthoringManifest,
  MarketplacePluginComponents,
} from '../../shared/marketplace'
import {
  MARKETPLACE_COMPONENT_KINDS,
  parseMarketplacePluginAuthoringManifest,
  parseMarketplacePluginManifest,
} from '../../shared/marketplace'
import { parseThirdPartyModuleManifest } from '../../shared/modules/third-party-manifest'
import { marketplaceComponentDigestMismatchIssuesSync } from '../../../packages/module-sdk/src/plugin-component-digests'
import { installPluginFolder as installCliPluginFolder } from '../plugin-install'
import { validateManifestSource } from '../plugin-registry'
import { getPluginRegistryUserRoot, reloadPluginRegistry } from '../plugin-registry-instance'
import { normalizeMcpClients, normalizeMcpServerConfig, type McpConfigService } from '../mcp-config-service'
import type { SkillPackService } from '../skill-pack-service'
import { classifyModuleTrust, isLoadEligible, type ModuleTrust, type ModuleTrustContext } from './module-signature'
import { defaultUserModuleRoot, installModuleFolder as installCapabilityModuleFolder } from './user-module-registry'

const DEFAULT_MCP_CLIENTS: McpClientTarget[] = ['codex', 'claude-code']
const DEFAULT_SKILL_HARNESSES: SkillPackHarness[] = ['agents']

type ComponentPath = { kind: MarketplaceComponentKind; path: string }

export type MarketplacePluginInstallerServices = {
  trustContext: () => ModuleTrustContext
  mcpConfigService: McpConfigService
  skillPackService: SkillPackService
  moduleRoot?: () => string
  pluginRoot?: () => string
  installModuleFolder?: typeof installCapabilityModuleFolder
  installPluginFolder?: typeof installCliPluginFolder
  reloadPlugins?: () => void
}

type ResolvedComponent =
  | { kind: 'mcp'; path: string; servers: McpServerConfig[] }
  | { kind: 'skills'; path: string; installedDirName: string }
  | { kind: 'module'; path: string; id: string; trust: ModuleTrust }
  | { kind: 'cli'; path: string; id: string }

type ResolvedInstallPlan = {
  components: ResolvedComponent[]
  trust: ModuleTrust
}

export function createMarketplacePluginInstaller(services: MarketplacePluginInstallerServices) {
  return (input: MarketplacePluginInstallInput): Promise<MarketplacePluginInstallResult> =>
    installMarketplacePlugin(input, services)
}

export async function installMarketplacePlugin(
  input: MarketplacePluginInstallInput,
  services: MarketplacePluginInstallerServices
): Promise<MarketplacePluginInstallResult> {
  const installed: MarketplacePluginInstalledComponent[] = []
  const preflight = await buildInstallPlan(input, services.trustContext())
  if (!preflight.ok) return preflight.result

  const { manifest, plan } = preflight
  let nextMcpSettings: McpSettings | undefined

  for (const component of plan.components) {
    const result = await installComponent(component, input, services, installed)
    if (!result.ok) return result.result
    if (result.mcpSettings) nextMcpSettings = result.mcpSettings
    installed.push(result.installed)
  }

  return {
    ok: true,
    id: manifest.id,
    displayName: manifest.displayName,
    version: manifest.version,
    trust: plan.trust.status,
    loadEligible: isLoadEligible(plan.trust.status),
    installed,
    ...(nextMcpSettings ? { mcpSettings: nextMcpSettings } : {}),
  }
}

async function buildInstallPlan(
  input: MarketplacePluginInstallInput,
  trustContext: ModuleTrustContext
): Promise<
  | { ok: true; manifest: MarketplacePluginAuthoringManifest; plan: ResolvedInstallPlan }
  | { ok: false; result: MarketplacePluginInstallResult }
> {
  const localFolder = typeof input.localFolder === 'string' ? input.localFolder.trim() : ''
  if (!localFolder) {
    return failure('No plugin folder selected.')
  }

  const bundleRoot = await resolveBundleRoot(localFolder)
  if (!bundleRoot.ok) return failure(bundleRoot.message)

  const manifestSource = await readText(join(bundleRoot.path, 'plugin.json'), 'plugin.json')
  if (!manifestSource.ok) {
    return failure('No plugin.json found in the selected plugin bundle.', undefined, manifestSource.issues)
  }

  const resolvedManifest = resolveInstallManifest(manifestSource.source)
  if (!resolvedManifest.ok) {
    return failure('plugin.json is invalid.', undefined, resolvedManifest.issues)
  }
  const manifest = resolvedManifest.manifest

  const trust = classifyModuleTrust(manifest, trustContext)
  if (trust.status === 'invalid') {
    return failure('Plugin bundle signature is invalid.', undefined, [{ path: 'signature', message: 'Invalid signature.' }], {
      trust: trust.status,
      loadEligible: false,
    })
  }
  // Mirror the download gate (defense in depth): an unsigned module/cli must
  // never install, so a bypassed download cannot slip code past this point.
  // Unsigned mcp/skills-only bundles are permitted (loadEligible false). Gate on
  // signature presence so id-trust cannot promote an unsigned code component.
  if (!manifest.signature && hasCodeBearingComponent(manifest.components)) {
    return failure('Plugin bundle is unsigned and cannot be installed.', undefined, [{ path: 'signature', message: 'signature is required.' }], {
      trust: trust.status,
      loadEligible: false,
    })
  }

  const digestMismatch = marketplaceComponentDigestMismatchIssuesSync(bundleRoot.path, manifest, {
    bytesLabel: 'current bytes',
    blockedFileMessage: (path) => `component file "${path}" cannot be installed from marketplace bundles.`,
  })
  if (digestMismatch.length > 0) {
    return failure('Plugin bundle component digests do not match its signed manifest.', undefined, digestMismatch, {
      trust: trust.status,
      loadEligible: isLoadEligible(trust.status),
    })
  }

  const resolvedComponents: ResolvedComponent[] = []
  for (const component of componentPaths(manifest.components)) {
    const resolved = await resolveComponent(bundleRoot.path, component)
    if (!resolved.ok) return failure(resolved.message, component.kind)

    const prepared = await prepareComponent(resolved.path, component.kind, input, trustContext)
    if (!prepared.ok) return failure(prepared.message, component.kind, prepared.issues)
    resolvedComponents.push(prepared.component)
  }

  return {
    ok: true,
    manifest,
    plan: { components: resolvedComponents, trust },
  }
}

type ResolvedInstallManifest =
  | { ok: true; manifest: MarketplacePluginAuthoringManifest }
  | { ok: false; issues: MarketplaceManifestIssue[] }

// Parse a staged plugin.json. A signed manifest is validated strictly; a
// manifest whose only defect is a missing signature is accepted as unsigned so
// the kind-aware gate above can permit unsigned mcp/skills-only bundles. Any
// other defect (malformed/present signature, structural errors) is rejected.
function resolveInstallManifest(source: string): ResolvedInstallManifest {
  const signed = parseMarketplacePluginManifest(source)
  if (signed.ok) return { ok: true, manifest: signed.manifest }
  const authoring = parseMarketplacePluginAuthoringManifest(source)
  if (authoring.ok && authoring.manifest.signature === undefined) {
    return { ok: true, manifest: authoring.manifest }
  }
  return { ok: false, issues: signed.issues }
}

function hasCodeBearingComponent(components: MarketplacePluginComponents): boolean {
  return components.module !== undefined || components.cli !== undefined
}

async function installComponent(
  component: ResolvedComponent,
  input: MarketplacePluginInstallInput,
  services: MarketplacePluginInstallerServices,
  installed: MarketplacePluginInstalledComponent[]
): Promise<
  | { ok: true; installed: MarketplacePluginInstalledComponent; mcpSettings?: McpSettings }
  | { ok: false; result: MarketplacePluginInstallResult }
> {
  try {
    switch (component.kind) {
      case 'mcp':
        return installMcpComponent(component, input, services.mcpConfigService, installed)
      case 'skills':
        return await installSkillComponent(component, input, services.skillPackService, installed)
      case 'module':
        return await installModuleComponent(component, services, installed)
      case 'cli':
        return await installCliComponent(component, services, installed)
    }
  } catch (error) {
    return {
      ok: false,
      result: {
        ok: false,
        component: component.kind,
        message: formatError(error),
        installed,
      },
    }
  }
}

function installMcpComponent(
  component: Extract<ResolvedComponent, { kind: 'mcp' }>,
  input: MarketplacePluginInstallInput,
  service: McpConfigService,
  installed: MarketplacePluginInstalledComponent[]
): { ok: true; installed: MarketplacePluginInstalledComponent; mcpSettings: McpSettings } | { ok: false; result: MarketplacePluginInstallResult } {
  const workspaceRoot = input.workspaceRoot?.trim()
  if (!workspaceRoot) {
    return componentFailure('mcp', 'Workspace root is required to install MCP components.', installed)
  }

  const nextSettings: McpSettings = {
    syncEnabled: true,
    servers: {
      ...(input.mcpSettings?.servers ?? {}),
      ...Object.fromEntries(component.servers.map((server) => [server.id, server])),
    },
  }
  const clients = normalizeMcpClients(
    input.mcpClients?.length
      ? input.mcpClients
      : component.servers.flatMap((server) => server.clients) as McpClientTarget[]
  )
  const result = service.sync({ workspaceRoot, settings: nextSettings, clients, write: true })
  if (!result.ok) {
    return componentFailure('mcp', result.message, installed, mcpIssuesToMarketplaceIssues(result.issues))
  }

  const installedMcp = installedMcpComponent(component.servers)
  const partialInstalled = mcpTargetsIncludeServers(result.targets, component.servers)
    ? [...installed, installedMcp]
    : installed
  const coverageFailures = mcpClientSyncCoverageFailures(component.servers, clients, result.targets)
  const syncIssues = relevantMcpSyncIssues(result.issues, component.servers, clients)
  if (coverageFailures.length > 0 || syncIssues.length > 0) {
    return componentFailure(
      'mcp',
      coverageFailures.length > 0
        ? `MCP sync did not write requested client targets: ${formatMcpCoverageFailures(coverageFailures)}.`
        : 'MCP sync reported warnings for this MCP component.',
      partialInstalled,
      mergeMarketplaceIssues([
        ...coverageFailures.map(mcpCoverageFailureIssue),
        ...(mcpIssuesToMarketplaceIssues(syncIssues) ?? []),
      ])
    )
  }

  return {
    ok: true,
    installed: installedMcp,
    mcpSettings: nextSettings,
  }
}

async function installSkillComponent(
  component: Extract<ResolvedComponent, { kind: 'skills' }>,
  input: MarketplacePluginInstallInput,
  service: SkillPackService,
  installed: MarketplacePluginInstalledComponent[]
): Promise<
  | { ok: true; installed: MarketplacePluginInstalledComponent }
  | { ok: false; result: MarketplacePluginInstallResult }
> {
  const workspaceRoot = input.workspaceRoot?.trim()
  if (!workspaceRoot) {
    return componentFailure('skills', 'Workspace root is required to install skill components.', installed)
  }

  const result = await service.install({
    workspaceRoot,
    slug: component.path,
    harnesses: input.skillHarnesses?.length ? input.skillHarnesses : DEFAULT_SKILL_HARNESSES,
    installedDirName: component.installedDirName,
  })
  if (!result.ok) return componentFailure('skills', result.message, installed)

  const installedDirName = result.installed.installedDirName ?? result.installed.id
  const writtenSkillComponent: MarketplacePluginInstalledComponent = {
    kind: 'skills',
    id: result.installed.id,
    installedDirName,
    harnesses: result.installed.harnesses.length
      ? result.installed.harnesses
      : input.skillHarnesses?.length
        ? input.skillHarnesses
        : DEFAULT_SKILL_HARNESSES,
    message: `Installed for ${result.installed.harnesses.join(', ') || 'configured harnesses'}.`,
  }
  const listed = await service.listInstalled({ workspaceRoot })
  if (!listed.ok) {
    return componentFailure('skills', `Skill component installed but could not be listed: ${listed.message}`, [
      ...installed,
      writtenSkillComponent,
    ])
  }
  const listedEntry = listed.installed.find((entry) =>
    entry.id === result.installed.id || entry.installedDirName === installedDirName
  )
  if (!listedEntry) {
    return componentFailure('skills', `Skill component "${installedDirName}" was not found after install.`, [
      ...installed,
      writtenSkillComponent,
    ])
  }

  return {
    ok: true,
    installed: {
      kind: 'skills',
      id: listedEntry.id,
      installedDirName,
      harnesses: listedEntry.harnesses,
      message: `Installed for ${listedEntry.harnesses.join(', ') || 'configured harnesses'}.`,
    },
  }
}

async function installModuleComponent(
  component: Extract<ResolvedComponent, { kind: 'module' }>,
  services: MarketplacePluginInstallerServices,
  installed: MarketplacePluginInstalledComponent[]
): Promise<
  | { ok: true; installed: MarketplacePluginInstalledComponent }
  | { ok: false; result: MarketplacePluginInstallResult }
> {
  const installer = services.installModuleFolder ?? installCapabilityModuleFolder
  const result = await installer(component.path, (services.moduleRoot ?? defaultUserModuleRoot)(), services.trustContext())
  if (!result.ok) {
    return componentFailure('module', result.message, installed, result.rejected.issues)
  }
  if (result.trust.status === 'invalid') {
    return componentFailure('module', `Module "${result.id}" has an invalid signature and was not accepted.`, installed)
  }
  return {
    ok: true,
    installed: {
      kind: 'module',
      id: result.id,
      message: `Installed with trust status ${result.trust.status}; load eligible: ${isLoadEligible(result.trust.status) ? 'yes' : 'no'}.`,
    },
  }
}

async function installCliComponent(
  component: Extract<ResolvedComponent, { kind: 'cli' }>,
  services: MarketplacePluginInstallerServices,
  installed: MarketplacePluginInstalledComponent[]
): Promise<
  | { ok: true; installed: MarketplacePluginInstalledComponent }
  | { ok: false; result: MarketplacePluginInstallResult }
> {
  const installer = services.installPluginFolder ?? installCliPluginFolder
  const result = await installer(component.path, (services.pluginRoot ?? getPluginRegistryUserRoot)())
  if (!result.ok) return componentFailure('cli', result.message, installed, result.issues)

  const reload = services.reloadPlugins ?? reloadPluginRegistry
  reload()
  return {
    ok: true,
    installed: { kind: 'cli', id: result.id, message: `Installed ${result.displayName}.` },
  }
}

async function prepareComponent(
  path: string,
  kind: MarketplaceComponentKind,
  input: MarketplacePluginInstallInput,
  trustContext: ModuleTrustContext
): Promise<{ ok: true; component: ResolvedComponent } | { ok: false; message: string; issues?: MarketplaceManifestIssue[] }> {
  switch (kind) {
    case 'mcp':
      return prepareMcpComponent(path, input)
    case 'skills':
      return prepareSkillComponent(path)
    case 'module':
      return prepareModuleComponent(path, trustContext)
    case 'cli':
      return prepareCliComponent(path)
  }
}

async function prepareMcpComponent(
  path: string,
  input: MarketplacePluginInstallInput
): Promise<{ ok: true; component: ResolvedComponent } | { ok: false; message: string; issues?: MarketplaceManifestIssue[] }> {
  const source = await readText(path, 'MCP component')
  if (!source.ok) return { ok: false, message: 'MCP component could not be read.', issues: source.issues }

  let parsed: unknown
  try {
    parsed = JSON.parse(source.source)
  } catch (error) {
    return {
      ok: false,
      message: 'MCP component is not valid JSON.',
      issues: [{ path: '', message: error instanceof Error ? error.message : 'Invalid JSON.' }],
    }
  }

  const issues: MarketplaceManifestIssue[] = []
  const servers = extractMcpServers(parsed, input.mcpClients, issues)
  if (issues.length > 0 || servers.length === 0) {
    return {
      ok: false,
      message: servers.length === 0 ? 'MCP component must declare at least one server.' : 'MCP component is invalid.',
      issues,
    }
  }
  return { ok: true, component: { kind: 'mcp', path, servers } }
}

async function prepareSkillComponent(path: string): Promise<{ ok: true; component: ResolvedComponent } | { ok: false; message: string; issues?: MarketplaceManifestIssue[] }> {
  const info = await stat(path).catch(() => null)
  if (!info?.isDirectory()) {
    return { ok: false, message: 'Skill component must be a directory.' }
  }
  const skillFile = await stat(join(path, 'SKILL.md')).catch(() => null)
  if (!skillFile?.isFile()) {
    return {
      ok: false,
      message: 'Skill component directory must contain SKILL.md.',
      issues: [{ path: 'SKILL.md', message: 'SKILL.md is required.' }],
    }
  }
  return { ok: true, component: { kind: 'skills', path, installedDirName: basename(path) } }
}

async function prepareModuleComponent(
  path: string,
  trustContext: ModuleTrustContext
): Promise<{ ok: true; component: ResolvedComponent } | { ok: false; message: string; issues?: MarketplaceManifestIssue[] }> {
  const manifest = await readText(join(path, 'manifest.json'), 'module manifest')
  if (!manifest.ok) return { ok: false, message: 'No manifest.json found in module component.', issues: manifest.issues }

  const parsed = parseThirdPartyModuleManifest(manifest.source)
  if (!parsed.ok) return { ok: false, message: 'Module component manifest is invalid.', issues: parsed.issues }

  const trust = classifyModuleTrust(parsed.manifest, trustContext)
  if (trust.status === 'invalid') {
    return {
      ok: false,
      message: `Module "${parsed.manifest.id}" has an invalid signature and cannot be installed.`,
      issues: [{ path: 'signature', message: 'Invalid signature.' }],
    }
  }
  return { ok: true, component: { kind: 'module', path, id: parsed.manifest.id, trust } }
}

async function prepareCliComponent(path: string): Promise<{ ok: true; component: ResolvedComponent } | { ok: false; message: string; issues?: MarketplaceManifestIssue[] }> {
  const manifest = await readText(join(path, 'plugin.json'), 'CLI plugin manifest')
  if (!manifest.ok) return { ok: false, message: 'No plugin.json found in CLI component.', issues: manifest.issues }

  const parsed = validateManifestSource(manifest.source)
  if (!parsed.ok) return { ok: false, message: 'CLI component plugin.json is invalid.', issues: parsed.issues }
  if (parsed.manifest.kind === 'provider') {
    return {
      ok: false,
      message: 'CLI component must contain a CLI plugin manifest, not a provider manifest.',
      issues: [{ path: 'kind', message: 'Provider manifests are not valid CLI components.' }],
    }
  }
  return { ok: true, component: { kind: 'cli', path, id: parsed.manifest.id } }
}

function extractMcpServers(
  value: unknown,
  inputClients: McpClientTarget[] | undefined,
  issues: MarketplaceManifestIssue[]
): McpServerConfig[] {
  const fallbackClients = inputClients?.length ? inputClients : DEFAULT_MCP_CLIENTS
  const rawServers = rawMcpServerEntries(value, issues)
  const servers: McpServerConfig[] = []
  for (const [label, raw] of rawServers) {
    const server = normalizeMcpServer(raw, label, fallbackClients, issues)
    if (server) servers.push(server)
  }
  return servers
}

function rawMcpServerEntries(value: unknown, issues: MarketplaceManifestIssue[]): Array<[string, unknown]> {
  if (!isRecord(value)) {
    issues.push({ path: '', message: 'MCP component must be a JSON object.' })
    return []
  }
  if (isRecord(value.server)) return [['server', value.server]]
  if (Array.isArray(value.servers)) return value.servers.map((server, index) => [`servers[${index}]`, server])
  if (isRecord(value.servers)) {
    return Object.entries(value.servers).map(([id, server]) => {
      if (isRecord(server) && server.id === undefined) return [`servers.${id}`, { ...server, id }]
      return [`servers.${id}`, server]
    })
  }
  if (typeof value.id === 'string') return [['server', value]]
  issues.push({ path: 'servers', message: 'MCP component must declare server or servers.' })
  return []
}

function normalizeMcpServer(
  value: unknown,
  path: string,
  fallbackClients: McpClientTarget[],
  issues: MarketplaceManifestIssue[]
): McpServerConfig | null {
  if (!isRecord(value)) {
    issues.push({ path, message: 'MCP server must be an object.' })
    return null
  }

  const server = normalizeMcpServerConfig(value, {
    enabled: true,
    clients: fallbackClients,
    scope: 'workspace',
    source: 'custom',
  })
  if (!server) {
    issues.push({ path, message: 'MCP server is invalid.' })
    return null
  }
  return server
}

async function resolveBundleRoot(path: string): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  const resolved = resolve(path)
  const real = await realpath(resolved).catch(() => null)
  if (!real) return { ok: false, message: 'Selected plugin folder does not exist.' }
  const info = await stat(real).catch(() => null)
  if (!info?.isDirectory()) return { ok: false, message: 'Selected plugin path is not a folder.' }
  return { ok: true, path: real }
}

async function resolveComponent(
  bundleRoot: string,
  component: ComponentPath
): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  const candidate = resolve(bundleRoot, component.path)
  if (!isInsideOrEqual(bundleRoot, candidate)) {
    return { ok: false, message: `${component.kind} component path must stay inside the plugin bundle.` }
  }
  const real = await realpath(candidate).catch(() => null)
  if (!real) return { ok: false, message: `${component.kind} component path does not exist.` }
  if (!isInsideOrEqual(bundleRoot, real)) {
    return { ok: false, message: `${component.kind} component path resolves outside the plugin bundle.` }
  }
  return { ok: true, path: real }
}

function componentPaths(components: MarketplacePluginComponents): ComponentPath[] {
  return MARKETPLACE_COMPONENT_KINDS
    .map((kind) => components[kind] ? { kind, path: components[kind]!.path } : null)
    .filter((component): component is ComponentPath => component !== null)
}

async function readText(path: string, label: string): Promise<{ ok: true; source: string } | { ok: false; issues: MarketplaceManifestIssue[] }> {
  try {
    return { ok: true, source: await readFile(path, 'utf8') }
  } catch (error) {
    return { ok: false, issues: [{ path: '', message: `${label}: ${formatError(error)}` }] }
  }
}

function failure(
  message: string,
  component?: MarketplaceComponentKind,
  issues?: MarketplaceManifestIssue[],
  extra?: Pick<Extract<MarketplacePluginInstallResult, { ok: false }>, 'trust' | 'loadEligible'>
): { ok: false; result: MarketplacePluginInstallResult } {
  return { ok: false, result: { ok: false, message, ...(component ? { component } : {}), ...(issues ? { issues } : {}), ...(extra ?? {}) } }
}

function componentFailure(
  component: MarketplaceComponentKind,
  message: string,
  installed: MarketplacePluginInstalledComponent[],
  issues?: MarketplaceManifestIssue[]
): { ok: false; result: MarketplacePluginInstallResult } {
  return {
    ok: false,
    result: {
      ok: false,
      component,
      message,
      installed,
      ...(issues ? { issues } : {}),
    },
  }
}

function isInsideOrEqual(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function installedMcpComponent(servers: McpServerConfig[]): MarketplacePluginInstalledComponent {
  return {
    kind: 'mcp',
    id: servers.map((server) => server.id).join(','),
    serverIds: servers.map((server) => server.id),
    servers,
    message: `Synced ${servers.length} MCP server${servers.length === 1 ? '' : 's'}.`,
  }
}

function mcpTargetsIncludeServers(targets: McpSyncTarget[], servers: McpServerConfig[]): boolean {
  const serverIds = new Set(servers.map((server) => server.id))
  return targets.some((target) => target.serverIds.some((serverId) => serverIds.has(serverId)))
}

function mcpClientSyncCoverageFailures(
  servers: McpServerConfig[],
  clients: McpClientTarget[],
  targets: McpSyncTarget[]
): Array<{ client: McpClientTarget; serverIds: string[] }> {
  const targetServerIdsByClient = new Map<McpClientTarget, Set<string>>()
  for (const target of targets) {
    const serverIds = targetServerIdsByClient.get(target.client) ?? new Set<string>()
    for (const serverId of target.serverIds) serverIds.add(serverId)
    targetServerIdsByClient.set(target.client, serverIds)
  }

  const failures: Array<{ client: McpClientTarget; serverIds: string[] }> = []
  for (const client of clients) {
    const expectedServerIds = servers
      .filter((server) => server.clients.includes(client))
      .map((server) => server.id)
    if (expectedServerIds.length === 0) continue

    const syncedServerIds = targetServerIdsByClient.get(client) ?? new Set<string>()
    const missing = expectedServerIds.filter((serverId) => !syncedServerIds.has(serverId))
    if (missing.length > 0) failures.push({ client, serverIds: missing })
  }
  return failures
}

function relevantMcpSyncIssues(
  issues: McpValidationIssue[] | undefined,
  servers: McpServerConfig[],
  clients: McpClientTarget[]
): McpValidationIssue[] {
  if (!issues?.length) return []

  const serverIds = new Set(servers.map((server) => server.id))
  const componentClients = new Set(
    clients.filter((client) => servers.some((server) => server.clients.includes(client)))
  )
  return issues.filter((issue) => {
    if (issue.serverId && serverIds.has(issue.serverId)) return true
    if (issue.client && componentClients.has(issue.client)) return true
    return false
  })
}

function formatMcpCoverageFailures(failures: Array<{ client: McpClientTarget; serverIds: string[] }>): string {
  return failures
    .map((failure) => `${failure.client} (${failure.serverIds.join(', ')})`)
    .join('; ')
}

function mcpCoverageFailureIssue(failure: { client: McpClientTarget; serverIds: string[] }): MarketplaceManifestIssue {
  return {
    path: `clients.${failure.client}`,
    message: `MCP sync did not write ${failure.serverIds.join(', ')} to ${failure.client}.`,
  }
}

function mergeMarketplaceIssues(issues: MarketplaceManifestIssue[]): MarketplaceManifestIssue[] | undefined {
  if (issues.length === 0) return undefined
  const seen = new Set<string>()
  const merged: MarketplaceManifestIssue[] = []
  for (const issue of issues) {
    const key = `${issue.path}\n${issue.message}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(issue)
  }
  return merged
}

function mcpIssuesToMarketplaceIssues(
  issues: Array<{ serverId?: string; client?: string; message: string }> | undefined
): MarketplaceManifestIssue[] | undefined {
  if (!issues?.length) return undefined
  return issues.map((issue) => ({
    path: issue.serverId ? `servers.${issue.serverId}` : issue.client ? `clients.${issue.client}` : '',
    message: issue.message,
  }))
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
