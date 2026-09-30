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
  SkillHarness,
} from '../../shared/electron-api'
import type {
  MarketplaceComponentKind,
  MarketplaceManifestIssue,
  MarketplacePluginAuthoringManifest,
  MarketplacePluginComponents,
} from '../../shared/marketplace'
import {
  MARKETPLACE_COMPONENT_KINDS,
  hasCodeBearingComponent,
  resolveOptionallySignedManifest,
  retiredMarketplaceComponentIssue,
} from '../../shared/marketplace'
import { LIVE_ENABLED_MODULE_IDS, type CapabilityManifest, type ModuleFileDigests } from '../../shared/modules/manifest'
import { parseThirdPartyModuleManifest } from '../../shared/modules/third-party-manifest'
import { marketplaceComponentDigestMismatchIssuesSync } from '../../../packages/module-sdk/src/plugin-component-digests'
import { normalizeMcpClients, normalizeMcpServerConfig, type McpConfigService } from '../mcp-config-service'
import { installSkillDirectory } from '../skills/install'
import {
  classifyModuleTrust,
  classifySignedManifestTrust,
  isLoadEligible,
  isSignedByTrustedPublisher,
  moduleContentFingerprint,
  type ModuleTrust,
  type ModuleTrustContext,
} from './module-signature'
import { defaultUserModuleRoot, installModuleFolder as installCapabilityModuleFolder } from './user-module-registry'
import { isRecord } from '../../shared/records'
import { withObservedUnsignedDigests } from '../marketplace/unsigned-component-digests'

const DEFAULT_MCP_CLIENTS: McpClientTarget[] = ['codex', 'claude-code']
const DEFAULT_SKILL_HARNESSES: SkillHarness[] = ['agents']

// The component kinds a bundle can install. Agent CLIs are not among them:
// they ship with the app, and an extension may not add or replace one.
type BundleComponentKind = Exclude<MarketplaceComponentKind, 'cli'>
const BUNDLE_COMPONENT_KINDS = MARKETPLACE_COMPONENT_KINDS.filter(
  (kind): kind is BundleComponentKind => (kind as string) !== 'cli',
)

type ComponentPath = { kind: BundleComponentKind; path: string }

export type MarketplacePluginInstallerServices = {
  trustContext: () => ModuleTrustContext
  mcpConfigService: McpConfigService
  moduleRoot?: () => string
  installModuleFolder?: typeof installCapabilityModuleFolder
}

type ResolvedComponent =
  | { kind: 'mcp'; path: string; servers: McpServerConfig[] }
  | { kind: 'skills'; path: string; installedDirName: string }
  // `verifiedInstall` is the content fingerprint a trusted publisher's bundle
  // signature vouches for (see bundleVouchedModuleInstall), when it does.
  | { kind: 'module'; path: string; id: string; trust: ModuleTrust; verifiedInstall?: string }

type ResolvedInstallPlan = {
  components: ResolvedComponent[]
  trust: ModuleTrust
}

/**
 * Install-time facts the CALLER knows and the bundle cannot state about itself.
 * Not part of `MarketplacePluginInstallInput`, deliberately: that type crosses
 * IPC from the renderer, and `requireTrustedModuleComponents` is derived in main
 * from the download's own classification — a renderer that could set it could
 * also clear it.
 */
export type MarketplacePluginInstallOptions = {
  /**
   * G1. The bundle verified as `verified` — signed by a publisher listed in
   * `trusted-publishers.json` — so any module it carries must ALSO be signed by
   * one, and the install refuses the bundle outright otherwise.
   *
   * Why the inner manifest and not just the bundle: `verified` installs skip
   * the trust prompt entirely (see installFlow.ts), and the thing that decides
   * whether a module's code loads at launch is `classifyModuleTrust` on the
   * MODULE manifest, not on the bundle. A first-party bundle wrapping a module
   * signed by somebody else — or by nobody — would install silently and then
   * either sit awaiting a trust toggle nobody was told about, or, for a
   * reserved id, be rejected by the module registry after the fact. Both are a
   * first-party install that quietly did not do what it said.
   */
  requireTrustedModuleComponents?: boolean
  /**
   * An unsigned bundle carrying module code may install. Derived in main from
   * a trust grant for a GitHub-URL install the person trusted as code
   * (marketplace/trust-tokens.ts); the registry path never sets it.
   */
  allowUnsignedCode?: boolean
}

export async function installMarketplacePlugin(
  input: MarketplacePluginInstallInput,
  services: MarketplacePluginInstallerServices,
  options: MarketplacePluginInstallOptions = {},
): Promise<MarketplacePluginInstallResult> {
  const installed: MarketplacePluginInstalledComponent[] = []
  const preflight = await buildInstallPlan(input, services.trustContext(), options)
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
    restartRequired: installRequiresRestart(installed),
    ...(nextMcpSettings ? { mcpSettings: nextMcpSettings } : {}),
  }
}

/**
 * The MCP servers a staged bundle would add, parsed exactly as the install
 * parses them, for a trust prompt to disclose. A component that does not
 * parse discloses nothing here; the install refuses it with the reason.
 */
export async function readBundleMcpServers(
  bundleRoot: string,
  manifest: MarketplacePluginAuthoringManifest,
): Promise<McpServerConfig[]> {
  const component = manifest.components.mcp
  if (!component) return []
  const root = await resolveBundleRoot(bundleRoot)
  if (!root.ok) return []
  const resolved = await resolveComponent(root.path, { kind: 'mcp', path: component.path })
  if (!resolved.ok) return []
  const source = await readText(resolved.path, 'MCP component')
  if (!source.ok) return []
  try {
    return extractMcpServers(JSON.parse(source.source), undefined, [])
  } catch {
    return []
  }
}

/**
 * G7. A module's `entry.main` is loaded once, at app launch, for every module
 * outside `LIVE_ENABLED_MODULE_IDS` — so an install that landed one has not
 * actually put it in the app yet, and saying a flat "Installed." sends the
 * person looking for a door that is not there until they relaunch. Computed
 * here, from the components that were really written, so the answer travels
 * with the result rather than being guessed at by the surface.
 *
 * Only module components: an MCP server and a skill both take effect
 * immediately.
 */
function installRequiresRestart(installed: MarketplacePluginInstalledComponent[]): boolean {
  return installed.some((component) => component.kind === 'module' && !LIVE_ENABLED_MODULE_IDS.includes(component.id))
}

async function buildInstallPlan(
  input: MarketplacePluginInstallInput,
  trustContext: ModuleTrustContext,
  options: MarketplacePluginInstallOptions,
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

  const resolvedManifest = resolveOptionallySignedManifest(manifestSource.source)
  if (!resolvedManifest.ok) {
    // A bundle built for an older Studio is refused for that, by name.
    const retired = retiredMarketplaceComponentIssue(resolvedManifest.issues)
    return failure(retired?.message ?? 'plugin.json is invalid.', undefined, resolvedManifest.issues)
  }
  const manifest = resolvedManifest.manifest

  const trust = classifySignedManifestTrust(manifest, trustContext)
  if (trust.status === 'invalid') {
    return failure(
      'Plugin bundle signature is invalid.',
      undefined,
      [{ path: 'signature', message: 'Invalid signature.' }],
      {
        trust: trust.status,
        loadEligible: false,
      },
    )
  }
  // Mirror the download gate (defense in depth): an unsigned module must never
  // install unless the person trusted it as code, so a bypassed download cannot
  // slip code past this point. Unsigned mcp/skills-only bundles are permitted
  // (loadEligible false). Gate on signature presence so id-trust cannot promote
  // an unsigned code component.
  if (!manifest.signature && hasCodeBearingComponent(manifest.components) && options.allowUnsignedCode !== true) {
    return failure(
      'Plugin bundle is unsigned and cannot be installed.',
      undefined,
      [{ path: 'signature', message: 'signature is required.' }],
      {
        trust: trust.status,
        loadEligible: false,
      },
    )
  }

  // Agent CLIs ship with the app. A bundle that still names one is refused
  // whole rather than installed without it and called a success.
  if ((manifest.components as Record<string, unknown>).cli !== undefined) {
    return failure(
      'Plugin bundle carries an agent CLI, which extensions can no longer install.',
      undefined,
      [{ path: 'components.cli', message: 'Agent CLIs ship with the app.' }],
      { trust: trust.status, loadEligible: false },
    )
  }

  const digestMismatch = marketplaceComponentDigestMismatchIssuesSync(
    bundleRoot.path,
    // An unsigned bundle's undigested components are held to the pin instead.
    withObservedUnsignedDigests(bundleRoot.path, manifest),
    {
      bytesLabel: 'current bytes',
      blockedFileMessage: (path) => `component file "${path}" cannot be installed from marketplace bundles.`,
    },
  )
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

    const prepared = await prepareComponent(resolved.path, component.kind, input, manifest, trustContext, options)
    if (!prepared.ok) return failure(prepared.message, component.kind, prepared.issues)
    resolvedComponents.push(prepared.component)
  }

  return {
    ok: true,
    manifest,
    plan: { components: resolvedComponents, trust },
  }
}

async function installComponent(
  component: ResolvedComponent,
  input: MarketplacePluginInstallInput,
  services: MarketplacePluginInstallerServices,
  installed: MarketplacePluginInstalledComponent[],
): Promise<
  | { ok: true; installed: MarketplacePluginInstalledComponent; mcpSettings?: McpSettings }
  | { ok: false; result: MarketplacePluginInstallResult }
> {
  try {
    switch (component.kind) {
      case 'mcp':
        return await installMcpComponent(component, input, services.mcpConfigService, installed)
      case 'skills':
        return await installSkillComponent(component, input, installed)
      case 'module':
        return await installModuleComponent(component, services, installed)
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

async function installMcpComponent(
  component: Extract<ResolvedComponent, { kind: 'mcp' }>,
  input: MarketplacePluginInstallInput,
  service: McpConfigService,
  installed: MarketplacePluginInstalledComponent[],
): Promise<
  | { ok: true; installed: MarketplacePluginInstalledComponent; mcpSettings: McpSettings }
  | { ok: false; result: MarketplacePluginInstallResult }
> {
  const workspaceRoot = input.workspaceRoot?.trim()
  if (!workspaceRoot) {
    return componentFailure('mcp', 'Workspace root is required to install MCP components.', installed)
  }

  const nextSettings: McpSettings = {
    syncEnabled: true,
    servers: {
      ...input.mcpSettings?.servers,
      ...Object.fromEntries(component.servers.map((server) => [server.id, server])),
    },
  }
  const clients = normalizeMcpClients(
    input.mcpClients?.length
      ? input.mcpClients
      : (component.servers.flatMap((server) => server.clients) as McpClientTarget[]),
  )
  const result = await service.sync({ workspaceRoot, settings: nextSettings, clients, write: true })
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
      ]),
    )
  }

  return {
    ok: true,
    installed: installedMcp,
    mcpSettings: nextSettings,
  }
}

// A bundle's skill component is a directory that is already on this machine, so
// it installs by the same copy the Skills surface uses. What it wrote back is
// the receipt: the harnesses in the result are the ones the copy actually
// landed in, not the ones that were asked for.
async function installSkillComponent(
  component: Extract<ResolvedComponent, { kind: 'skills' }>,
  input: MarketplacePluginInstallInput,
  installed: MarketplacePluginInstalledComponent[],
): Promise<
  { ok: true; installed: MarketplacePluginInstalledComponent } | { ok: false; result: MarketplacePluginInstallResult }
> {
  const workspaceRoot = input.workspaceRoot?.trim()
  if (!workspaceRoot) {
    return componentFailure('skills', 'Workspace root is required to install skill components.', installed)
  }

  const result = await installSkillDirectory({
    workspaceRoot,
    sourceDir: component.path,
    dirName: component.installedDirName,
    harnesses: input.skillHarnesses?.length ? input.skillHarnesses : DEFAULT_SKILL_HARNESSES,
  })
  if (!result.ok) return componentFailure('skills', result.message, installed)

  return {
    ok: true,
    installed: {
      kind: 'skills',
      id: result.dirName,
      installedDirName: result.dirName,
      harnesses: result.harnesses,
      message: `Installed for ${result.harnesses.join(', ')}.`,
    },
  }
}

async function installModuleComponent(
  component: Extract<ResolvedComponent, { kind: 'module' }>,
  services: MarketplacePluginInstallerServices,
  installed: MarketplacePluginInstalledComponent[],
): Promise<
  { ok: true; installed: MarketplacePluginInstalledComponent } | { ok: false; result: MarketplacePluginInstallResult }
> {
  const installer = services.installModuleFolder ?? installCapabilityModuleFolder
  const result = await installer(
    component.path,
    (services.moduleRoot ?? defaultUserModuleRoot)(),
    withVerifiedInstall(services.trustContext(), component.id, component.verifiedInstall),
  )
  if (!result.ok) {
    return componentFailure('module', result.message, installed, result.rejected.issues)
  }
  if (result.trust.status === 'invalid') {
    return componentFailure('module', `Module "${result.id}" has an invalid signature and was not accepted.`, installed)
  }
  // No trust mutation here: this runs mid-bundle, while a later component can
  // still fail and roll every file back. The receipt carries the trust identity
  // instead, and the lifecycle records the marketplace grant against
  // `manifestFp` only once the whole install has succeeded.
  return {
    ok: true,
    installed: {
      kind: 'module',
      id: result.id,
      trustStatus: result.trust.status,
      manifestFp: result.manifestFp,
      message: `Installed with trust status ${result.trust.status}; load eligible: ${isLoadEligible(result.trust.status) ? 'yes' : 'no'}.`,
    },
  }
}

async function prepareComponent(
  path: string,
  kind: BundleComponentKind,
  input: MarketplacePluginInstallInput,
  manifest: MarketplacePluginAuthoringManifest,
  trustContext: ModuleTrustContext,
  options: MarketplacePluginInstallOptions,
): Promise<
  { ok: true; component: ResolvedComponent } | { ok: false; message: string; issues?: MarketplaceManifestIssue[] }
> {
  switch (kind) {
    case 'mcp':
      return prepareMcpComponent(path, input)
    case 'skills':
      return prepareSkillComponent(path)
    case 'module':
      return prepareModuleComponent(path, trustContext, manifest, options)
  }
}

async function prepareMcpComponent(
  path: string,
  input: MarketplacePluginInstallInput,
): Promise<
  { ok: true; component: ResolvedComponent } | { ok: false; message: string; issues?: MarketplaceManifestIssue[] }
> {
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

async function prepareSkillComponent(
  path: string,
): Promise<
  { ok: true; component: ResolvedComponent } | { ok: false; message: string; issues?: MarketplaceManifestIssue[] }
> {
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
  trustContext: ModuleTrustContext,
  bundleManifest: MarketplacePluginAuthoringManifest,
  options: MarketplacePluginInstallOptions,
): Promise<
  { ok: true; component: ResolvedComponent } | { ok: false; message: string; issues?: MarketplaceManifestIssue[] }
> {
  const manifest = await readText(join(path, 'manifest.json'), 'module manifest')
  if (!manifest.ok)
    return { ok: false, message: 'No manifest.json found in module component.', issues: manifest.issues }

  const parsed = parseThirdPartyModuleManifest(manifest.source)
  if (!parsed.ok) return { ok: false, message: 'Module component manifest is invalid.', issues: parsed.issues }

  const verifiedInstall = bundleVouchedModuleInstall(bundleManifest, parsed.manifest, trustContext)
  const trust = classifyModuleTrust(
    parsed.manifest,
    path,
    withVerifiedInstall(trustContext, parsed.manifest.id, verifiedInstall),
  )
  if (trust.status === 'invalid') {
    return {
      ok: false,
      message: trust.tampered
        ? `Module "${parsed.manifest.id}" does not match the file digests its manifest signs and cannot be installed.`
        : `Module "${parsed.manifest.id}" has an invalid signature and cannot be installed.`,
      issues: trust.tampered ? trust.issues : [{ path: 'signature', message: 'Invalid signature.' }],
    }
  }
  // A signed module is what the install prompt's grant is recorded for. A
  // grant covers a module's code only through its own `files` digests (and a
  // key only through those or a trusted publisher's bundle), so a signed module
  // without them would be granted and then never load. Refused here, where its
  // publisher can be told to sign it again.
  if (parsed.manifest.signature && !parsed.manifest.files && !verifiedInstall) {
    return {
      ok: false,
      message:
        `Module "${parsed.manifest.id}" lists no digests of its code, so it could never be trusted. ` +
        'Its publisher must sign it with `sprintengine-module sign`, which records them.',
      issues: [{ path: 'files', message: 'the module manifest carries no file digests.' }],
    }
  }
  // G1. A first-party (verified) bundle installs with no trust prompt at all,
  // so the module inside it has to earn the same standing on its own: signed by
  // a publisher in trusted-publishers.json, which is what makes
  // `classifyModuleTrust` say 'trusted' rather than 'signed' or 'unsigned'.
  // Refused here, in preflight, so nothing has been written yet and the caller
  // rolls back exactly as it does for any other preflight failure.
  if (options.requireTrustedModuleComponents && trust.status !== 'trusted') {
    return {
      ok: false,
      message:
        `Module "${parsed.manifest.id}" is inside a verified first-party plugin, so its own manifest must be ` +
        `signed by a trusted publisher; this one is ${trust.status}. ` +
        'A first-party module manifest must be signed by a trusted publisher.',
      issues: [
        {
          path: 'signature',
          message: `module manifest trust is "${trust.status}"; a verified bundle requires "trusted".`,
        },
      ],
    }
  }
  // The trust prompt discloses the BUNDLE manifest's permissions (see the
  // header of src/renderer/src/components/settings/installFlow.ts), but the
  // trust decision ultimately covers the inner module. A module declaring
  // scopes its bundle never disclosed would make the grant authorize access
  // the user never saw — refuse the bundle rather than install past it.
  const disclosed = new Set<string>(bundleManifest.permissions ?? [])
  const undisclosed = (parsed.manifest.permissions ?? []).filter((permission) => !disclosed.has(permission))
  if (undisclosed.length > 0) {
    return {
      ok: false,
      message: `Module "${parsed.manifest.id}" declares permissions its plugin bundle does not disclose: ${undisclosed.join(', ')}.`,
      issues: undisclosed.map((permission) => ({
        path: 'permissions',
        message: `"${permission}" is declared by the module manifest but not by plugin.json.`,
      })),
    }
  }
  return {
    ok: true,
    component: {
      kind: 'module',
      path,
      id: parsed.manifest.id,
      trust,
      ...(verifiedInstall ? { verifiedInstall } : {}),
    },
  }
}

// A bundle signed by a trusted publisher signs a digest of every file in its
// module component, and buildInstallPlan has already held the bundle to them
// exactly. That vouches for the module's code even when the module's own
// manifest predates `files` — the first-party modules are shipped that way —
// so it is recorded as a verified install of that content. The digests come
// from the signed plugin.json, not from the disk. Any other bundle vouches for
// nothing here: its module earns trust by its own `files` or by a grant.
function bundleVouchedModuleInstall(
  bundleManifest: MarketplacePluginAuthoringManifest,
  moduleManifest: CapabilityManifest,
  trustContext: ModuleTrustContext,
): string | undefined {
  const component = bundleManifest.components.module
  if (!component?.files || !isSignedByTrustedPublisher(bundleManifest, trustContext)) return undefined
  const prefix = `${component.path}/`
  const files: ModuleFileDigests = {}
  for (const file of component.files) {
    if (!file.path.startsWith(prefix)) return undefined
    const relativePath = file.path.slice(prefix.length)
    if (relativePath !== 'manifest.json') files[relativePath] = file.sha256
  }
  return moduleContentFingerprint(moduleManifest, files)
}

function withVerifiedInstall(
  trustContext: ModuleTrustContext,
  moduleId: string,
  verifiedInstall: string | undefined,
): ModuleTrustContext {
  if (!verifiedInstall) return trustContext
  const installs = new Map(trustContext.verifiedModuleInstalls ?? [])
  installs.set(moduleId, verifiedInstall)
  return { ...trustContext, verifiedModuleInstalls: installs }
}

function extractMcpServers(
  value: unknown,
  inputClients: McpClientTarget[] | undefined,
  issues: MarketplaceManifestIssue[],
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
  issues: MarketplaceManifestIssue[],
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
  component: ComponentPath,
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
  return BUNDLE_COMPONENT_KINDS.map((kind) =>
    components[kind] ? { kind, path: components[kind]!.path } : null,
  ).filter((component): component is ComponentPath => component !== null)
}

async function readText(
  path: string,
  label: string,
): Promise<{ ok: true; source: string } | { ok: false; issues: MarketplaceManifestIssue[] }> {
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
  extra?: Pick<Extract<MarketplacePluginInstallResult, { ok: false }>, 'trust' | 'loadEligible'>,
): { ok: false; result: MarketplacePluginInstallResult } {
  return {
    ok: false,
    result: { ok: false, message, ...(component ? { component } : {}), ...(issues ? { issues } : {}), ...extra },
  }
}

function componentFailure(
  component: MarketplaceComponentKind,
  message: string,
  installed: MarketplacePluginInstalledComponent[],
  issues?: MarketplaceManifestIssue[],
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
  targets: McpSyncTarget[],
): Array<{ client: McpClientTarget; serverIds: string[] }> {
  const targetServerIdsByClient = new Map<McpClientTarget, Set<string>>()
  for (const target of targets) {
    const serverIds = targetServerIdsByClient.get(target.client) ?? new Set<string>()
    for (const serverId of target.serverIds) serverIds.add(serverId)
    targetServerIdsByClient.set(target.client, serverIds)
  }

  const failures: Array<{ client: McpClientTarget; serverIds: string[] }> = []
  for (const client of clients) {
    const expectedServerIds = servers.filter((server) => server.clients.includes(client)).map((server) => server.id)
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
  clients: McpClientTarget[],
): McpValidationIssue[] {
  if (!issues?.length) return []

  const serverIds = new Set(servers.map((server) => server.id))
  const componentClients = new Set(
    clients.filter((client) => servers.some((server) => server.clients.includes(client))),
  )
  return issues.filter((issue) => {
    if (issue.serverId && serverIds.has(issue.serverId)) return true
    if (issue.client && componentClients.has(issue.client)) return true
    return false
  })
}

function formatMcpCoverageFailures(failures: Array<{ client: McpClientTarget; serverIds: string[] }>): string {
  return failures.map((failure) => `${failure.client} (${failure.serverIds.join(', ')})`).join('; ')
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
  issues: Array<{ serverId?: string; client?: string; message: string }> | undefined,
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
