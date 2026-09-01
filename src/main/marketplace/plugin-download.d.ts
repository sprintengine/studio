import type { MarketplaceManifestIssue, MarketplacePluginAuthoringManifest, MarketplacePluginEntry } from '../../shared/marketplace';
import { type ModuleTrust, type ModuleTrustContext } from '../modules/module-signature';
import { type MarketplaceResourceResolver } from './resources';
export declare const DEFAULT_MARKETPLACE_PLUGIN_STAGING_DIR = "marketplace-plugin-staging";
export declare const DEFAULT_MARKETPLACE_PLUGIN_DOWNLOAD_TIMEOUT_MS = 30000;
export declare const DEFAULT_MARKETPLACE_PLUGIN_MAX_FILES = 500;
export declare const DEFAULT_MARKETPLACE_PLUGIN_MAX_FILE_BYTES: number;
export declare const DEFAULT_MARKETPLACE_PLUGIN_MAX_TOTAL_BYTES: number;
export type MarketplacePluginDownloadFetch = (url: string, init: RequestInit) => Promise<Response>;
export type MarketplacePluginTrustClassification = 'verified' | 'community' | 'unsigned' | 'invalid';
export type MarketplacePluginDownloadOptions = {
    entry: MarketplacePluginEntry;
    trustContext: ModuleTrustContext;
    stagingRoot?: string;
    fetcher?: MarketplacePluginDownloadFetch;
    timeoutMs?: number;
    maxFiles?: number;
    maxFileBytes?: number;
    maxTotalBytes?: number;
    packagedResourceResolver?: MarketplaceResourceResolver;
};
export type MarketplacePluginDownloadResult = {
    ok: true;
    classification: MarketplacePluginTrustClassification;
    sourceUrl: string;
    stagedBundlePath: string;
    manifest: MarketplacePluginAuthoringManifest;
    trust: ModuleTrust;
    loadEligible: boolean;
} | {
    ok: false;
    classification?: MarketplacePluginTrustClassification;
    sourceUrl: string;
    message: string;
    statusCode?: number;
    issues?: MarketplaceManifestIssue[];
    trust?: ModuleTrust;
};
export declare function defaultMarketplacePluginStagingRoot(userDataDir?: string): string;
export declare function downloadMarketplacePluginBundle(options: MarketplacePluginDownloadOptions): Promise<MarketplacePluginDownloadResult>;
/**
 * Structured log hook for the marketplace verify/install pipeline. Events are
 * short kebab-ish identifiers with a small detail record; the IPC layer wires
 * them into the diagnostics log so a failed verify or install is never
 * invisible.
 */
export type MarketplaceInstallLog = (event: string, detail?: Record<string, unknown>) => void;
export type ClaudeCodePluginDownloadOptions = {
    entry: MarketplacePluginEntry;
    stagingRoot?: string;
    /**
     * Refuse to stage when the bundled content identity differs from this pin.
     * The install passes the identity the pre-trust verify disclosed, so the
     * user can never trust listing A and install content B (an app/catalogue
     * update swapping the bundled payload between the prompt and the install).
     */
    refOverride?: string;
    /** Test seam for packaged resource resolution. */
    packagedResourceResolver?: MarketplaceResourceResolver;
    log?: MarketplaceInstallLog;
};
export type ClaudeCodePluginDownloadResult = {
    ok: true;
    sourceUrl: string;
    /** Staged copy of the plugin subtree (`.claude-plugin/` + `skills/`). */
    stagedPath: string;
    /** Skill folder names under the plugin's skills/ dir (each has a SKILL.md). */
    skillDirs: string[];
    /** The plugin's own name from .claude-plugin/plugin.json. */
    claudeName: string;
    /** The commit actually fetched (mutable refs resolve to a sha up front). */
    resolvedRef: string;
    /**
     * Names of skills the entry lists but that shipped metadata-only (no
     * bundled content — a snapshot capture cap), so the install can tell the
     * user which listed skills it did NOT install rather than silently
     * dropping them.
     */
    metadataOnlySkills: string[];
} | {
    ok: false;
    sourceUrl: string;
    message: string;
    statusCode?: number;
};
/**
 * Stage a Claude Code plugin's installable skill content from the BUNDLED
 * catalogue payload (resources/marketplace/skills/<entryId>/), never the
 * network: the old GitHub contents-API walk needed ~2x60 unauthenticated
 * calls for a large plugin against a 60/hour cap and died mid-"Verifying…".
 * Every staged folder is verified byte-for-byte against the entry's digest
 * listing before it is offered for install; an entry whose content did not
 * ship in the snapshot gets an honest "not installable offline yet" failure.
 * Commands/agents/hooks in the plugin are NOT staged or installed; skills are
 * the one component Multicode can honestly deliver today.
 */
export declare function downloadClaudeCodePluginSource(options: ClaudeCodePluginDownloadOptions): Promise<ClaudeCodePluginDownloadResult>;
