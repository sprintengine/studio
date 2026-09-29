// Part of the IPC contract: marketplace plugin install, verify and uninstall.
// ../electron-api.ts re-exports everything here.

import type { MarketplaceComponentKind, MarketplaceManifestIssue } from '../marketplace/manifest'
import type { ModuleTrustStatus } from '../modules/manifest'
import type { CapabilityPermission } from '../modules/permissions'
import type { SkillHarness } from '../skills'
import type { McpClientTarget, McpTransport } from './agent-runtime'
import type { McpServerConfig, McpSettings } from './mcp'

export type MarketplacePluginInstallInput = {
  localFolder: string
  workspaceRoot?: string
  mcpSettings?: McpSettings
  mcpClients?: McpClientTarget[]
  skillHarnesses?: SkillHarness[]
  // The CLI an agent-backed automation falls back to when its own config names
  // none (`appSettings.lastSelectedCli`, which only the renderer holds). An
  // automation component that would need it and does not get it refuses to
  // install, rather than creating a scheduled job that cannot launch.
  automationDefaultCli?: string
}

// What the renderer may say about a registry install: WHICH entry, and the
// trust token `verify` issued for it. The entry itself is resolved in main
// (from the token, or from the app's own registry), never taken from the
// renderer, and there is no yes/no to send back — the only way to say yes is
// a token main issued after disclosing the content it pins. An entry that
// needs no prompt (a verified publisher) may install without a token; when one
// is passed anyway, its pin still has to match what gets installed.
export type MarketplacePluginRegistryInstallInput = Omit<MarketplacePluginInstallInput, 'localFolder'> & {
  id: string
  trustToken?: string
}

export type MarketplacePluginVerifyInput = {
  id: string
}

// The content a trust prompt disclosed, pinned so the install can refuse
// anything else: the commit it was read at (GitHub sources), the sha256 of
// the manifest (plugin.json, an inline entry's server list, a skill plugin's
// listing) and a sha256 per installed file.
export type MarketplaceTrustPin = {
  commitSha?: string
  manifestSha256: string
  componentDigests: Record<string, string>
}

// An MCP server exactly as the install would write it, for the prompt: the
// command and every argument, the URL, and the NAMES of the environment
// variables and headers it sets — never their values.
export type MarketplaceMcpServerDisclosure = {
  id: string
  name: string
  transport: McpTransport
  command?: string
  args: string[]
  url?: string
  envKeys: string[]
  headerKeys: string[]
}

// Where an installed extension came from, on its receipt. `registry` is the
// app's marketplace index; `github` is a repository a person pasted, pinned to
// the commit its default branch (or the ref they named) pointed at when they
// reviewed it — the commit an update is compared against.
export type GithubExtensionOrigin = {
  // The repository as the person named it, normalised: https://github.com/o/r
  // plus `/tree/<ref>[/<path>]` when they named a ref.
  url: string
  owner: string
  repo: string
  ref?: string
}

export type MarketplaceInstallSource = { kind: 'registry' } | ({ kind: 'github'; sha: string } & GithubExtensionOrigin)

// "Install extension from GitHub…": what main found at the URL, for the trust
// review, and the one-time token that installs exactly that. A failure is a
// sentence for the person, never a partial preview.
export type GithubExtensionResolveInput = { url: string }

export type GithubExtensionPreview = {
  id: string
  displayName: string
  version: number
  publisher: { name: string; verified: boolean }
  summary: string
  provides: MarketplaceComponentKind[]
  origin: GithubExtensionOrigin
  // The review body, exactly as main's verify disclosed it (pin included).
  verify: MarketplacePluginVerifyResult & { classification: 'verified' | 'community' | 'unsigned' }
  // Set when this id is already installed: what the new review changes.
  installed?: GithubExtensionInstalledState
}

export type GithubExtensionInstalledState = {
  version: number
  sha?: string
  // What differs from what was approved last time. Empty means an update can
  // go ahead on the approval already given.
  changes: GithubExtensionReviewChange[]
}

export type GithubExtensionReviewChange = 'permissions' | 'mcp' | 'classification' | 'source'

export type GithubExtensionResolveResult =
  | { ok: true; preview: GithubExtensionPreview; trustToken: string }
  | { ok: false; message: string; issues?: MarketplaceManifestIssue[]; skillSource?: boolean }

export type GithubExtensionInstallInput = Omit<MarketplacePluginInstallInput, 'localFolder'> & {
  trustToken: string
  // The person's "I trust this code", required when the review showed
  // unsigned module code; main refuses that install without it.
  trustCode?: boolean
}

export type GithubExtensionCheckUpdateInput = { id: string }

export type GithubExtensionCheckUpdateResult =
  | { ok: true; state: 'current'; sha: string }
  | { ok: true; state: 'available'; preview: GithubExtensionPreview; trustToken: string; reviewRequired: boolean }
  | { ok: false; message: string }

export type MarketplacePluginUninstallInput = {
  pluginId: string
  workspaceRoot?: string
  mcpSettings?: McpSettings
  mcpClients?: McpClientTarget[]
  skillHarnesses?: SkillHarness[]
}

// Settings → Modules' uninstall, for a module however it arrived. `id` is the
// module's id (or a marketplace bundle's); the rest is the envelope an MCP or
// skill component's removal writes through, as for a marketplace uninstall.
export type ThirdPartyModuleUninstallInput = Omit<MarketplacePluginUninstallInput, 'pluginId'> & { id: string }

export type ThirdPartyModuleUninstallResult =
  { ok: true; removedModuleIds: string[]; mcpSettings?: McpSettings } | { ok: false; message: string }

export type MarketplacePluginTrustClassification = 'verified' | 'community' | 'unsigned' | 'invalid'

export type MarketplacePluginVerifyResult = {
  classification: MarketplacePluginTrustClassification
  permissions: CapabilityPermission[]
  sourceUrl: string
  issues?: MarketplaceManifestIssue[]
  message?: string
  // Real content listing disclosed at the trust prompt for entries whose
  // payload is files rather than capability permissions (Claude Code plugins:
  // the skill folders the trust grant installs). Never fabricated.
  files?: string[]
  // Every MCP server the install would add, as it would be written.
  mcpServers?: MarketplaceMcpServerDisclosure[]
  // The bundle carries a module — code that runs in the app.
  codeBearing?: boolean
  // The signer's key fingerprint (sha256 of the public key), when signed.
  keyFingerprint?: string
  // What was disclosed, and the one-time token that installs exactly that.
  // Absent when there is nothing installable to approve (invalid, or an
  // unsigned bundle carrying code from the registry).
  pin?: MarketplaceTrustPin
  trustToken?: string
}

export type MarketplacePluginInstalledComponent = {
  kind: MarketplaceComponentKind
  id: string
  message?: string
  serverIds?: string[]
  servers?: McpServerConfig[]
  harnesses?: SkillHarness[]
  installedDirName?: string
  // Module components only: the trust classification at install and the
  // installed manifest's content fingerprint — what the lifecycle's
  // post-success marketplace trust grant binds to (and what uninstall revokes).
  trustStatus?: ModuleTrustStatus
  manifestFp?: string
}

export type MarketplacePluginInstallResult =
  | {
      ok: true
      id: string
      displayName: string
      version: number
      trust: ModuleTrustStatus
      loadEligible: boolean
      installed: MarketplacePluginInstalledComponent[]
      mcpSettings?: McpSettings
      // Non-fatal disclosures about a successful install, e.g. skills the
      // entry lists that shipped without bundled content and so were not
      // installed. Surfaced to the user; never hidden behind ok:true.
      notices?: string[]
      /**
       * The install landed a module whose code only loads at app launch, so
       * nothing it contributes is there yet (D13). Derived in main from
       * `LIVE_ENABLED_MODULE_IDS` — the renderer is told the answer rather than
       * keeping its own copy of which modules are live-enabled. A renderer may
       * clear this conservative hint after successfully activating every new
       * renderer-only module from the install. Updates remain restart-only.
       */
      restartRequired?: boolean
    }
  | {
      ok: false
      message: string
      component?: MarketplaceComponentKind
      issues?: Array<{ path: string; message: string }>
      installed?: MarketplacePluginInstalledComponent[]
      trust?: ModuleTrustStatus
      loadEligible?: boolean
    }

export type MarketplacePluginRegistryInstallResult =
  | (Extract<MarketplacePluginInstallResult, { ok: true }> & {
      classification: Extract<MarketplacePluginTrustClassification, 'verified' | 'community' | 'unsigned'>
      sourceUrl: string
      updated: boolean
    })
  | (Extract<MarketplacePluginInstallResult, { ok: false }> & {
      classification?: MarketplacePluginTrustClassification
      sourceUrl?: string
      updated?: boolean
    })

export type MarketplacePluginUninstallResult =
  | {
      ok: true
      id: string
      removed: MarketplacePluginInstalledComponent[]
      mcpSettings?: McpSettings
    }
  | {
      ok: false
      message: string
      removed?: MarketplacePluginInstalledComponent[]
      mcpSettings?: McpSettings
    }

export type MarketplaceRegistryState = 'ok' | 'empty' | 'offline' | 'fetch-error' | 'invalid-schema'
