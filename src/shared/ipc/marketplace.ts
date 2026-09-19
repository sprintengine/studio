// Part of the IPC contract: marketplace plugin install, verify and uninstall.
// ../electron-api.ts re-exports everything here.

import type {
  MarketplaceComponentKind,
  MarketplaceManifestIssue,
  MarketplacePluginEntry,
} from '../marketplace/manifest'
import type { ModuleTrustStatus } from '../modules/manifest'
import type { CapabilityPermission } from '../modules/permissions'
import type { SkillHarness } from '../skills'
import type { McpClientTarget } from './agent-runtime'
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

// Both bundle and inline-MCP registry installs use this shape: a bundle entry
// carries `source`, an inline-MCP entry carries `mcp.servers` (no bundle to
// download). `trustGranted` is the server-side community/unsigned trust gate;
// inline-MCP is code-execution config and never installs without it.
export type MarketplacePluginRegistryInstallInput = Omit<MarketplacePluginInstallInput, 'localFolder'> & {
  entry: MarketplacePluginEntry
  trustGranted?: boolean
  // Claude Code plugins: the commit the pre-trust verify disclosed; the
  // install downloads this exact ref (TOCTOU guard for unpinned sources).
  claudePluginRef?: string
}

export type MarketplacePluginUninstallInput = {
  pluginId: string
  workspaceRoot?: string
  mcpSettings?: McpSettings
  mcpClients?: McpClientTarget[]
  skillHarnesses?: SkillHarness[]
}

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
  // The commit the listing was read from (Claude Code plugins). Passing it
  // back as MarketplacePluginRegistryInstallInput.claudePluginRef makes the
  // install fetch exactly the disclosed content — a mutable default-branch
  // source cannot swap bytes between the trust prompt and the install.
  pinnedRef?: string
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
