import { rm } from 'node:fs/promises';
import { isClaudeCodePluginEntry, validateMarketplaceIndex } from '../../shared/marketplace';
import { defaultMarketplacePluginStagingRoot, downloadClaudeCodePluginSource, downloadMarketplacePluginBundle, } from './plugin-download';
export function createMarketplacePluginVerifier(services) {
    return {
        verify: (entry) => verifyMarketplacePlugin(entry, services),
    };
}
export async function verifyMarketplacePlugin(entry, services) {
    const registryEntry = validateRegistryEntry(entry);
    if (!registryEntry.ok) {
        return {
            classification: 'invalid',
            permissions: [],
            sourceUrl: sourceUrlFromEntry(entry),
            issues: registryEntry.issues,
            message: registryEntry.message,
        };
    }
    // Claude Code plugins are unsigned by nature (no Multicode manifest to
    // verify); the pre-trust staging exists to disclose the REAL skill file
    // listing at the trust prompt — never a fabricated one. Content resolves
    // from the bundled catalogue payload and is digest-checked, so this is
    // local file reads: near-instant, zero network.
    if (isClaudeCodePluginEntry(registryEntry.entry)) {
        services.log?.('claude-plugin:verify-start', { entryId: registryEntry.entry.id });
        const claude = await downloadClaudeCodePluginSource({
            entry: registryEntry.entry,
            stagingRoot: services.stagingRoot ?? defaultMarketplacePluginStagingRoot(),
            packagedResourceResolver: services.packagedResourceResolver,
            log: services.log,
        });
        if (!claude.ok) {
            services.log?.('claude-plugin:verify-failed', { entryId: registryEntry.entry.id, message: claude.message });
            return {
                classification: 'invalid',
                permissions: [],
                sourceUrl: claude.sourceUrl,
                issues: [{ path: 'source', message: claude.message }],
                message: claude.message,
            };
        }
        try {
            services.log?.('claude-plugin:verify-ok', { entryId: registryEntry.entry.id, files: claude.skillDirs.length });
            return {
                classification: 'unsigned',
                permissions: [],
                sourceUrl: claude.sourceUrl,
                files: claude.skillDirs.map((dir) => `skills/${dir}`),
                // The bundled-content identity this listing came from; the install
                // re-checks exactly this pin so a catalogue/app update cannot swap
                // content between the trust grant and the install.
                pinnedRef: claude.resolvedRef,
            };
        }
        finally {
            await rm(claude.stagedPath, { recursive: true, force: true });
        }
    }
    const download = await downloadMarketplacePluginBundle({
        entry: registryEntry.entry,
        trustContext: services.trustContext(),
        stagingRoot: services.stagingRoot ?? defaultMarketplacePluginStagingRoot(),
        fetcher: services.fetcher,
    });
    if (!download.ok) {
        return {
            classification: download.classification ?? 'invalid',
            permissions: [],
            sourceUrl: download.sourceUrl,
            issues: download.issues ?? [{ path: 'source', message: download.message }],
            message: download.message,
        };
    }
    try {
        return {
            classification: download.classification,
            permissions: [...(download.manifest.permissions ?? [])],
            sourceUrl: download.sourceUrl,
        };
    }
    finally {
        await rm(download.stagedBundlePath, { recursive: true, force: true });
    }
}
function validateRegistryEntry(entry) {
    const result = validateMarketplaceIndex({ schemaVersion: 1, plugins: [entry] });
    if (!result.ok) {
        return {
            ok: false,
            message: 'Marketplace plugin registry entry is invalid.',
            issues: result.issues,
        };
    }
    const validated = result.marketplace.plugins[0];
    if (!validated) {
        return {
            ok: false,
            message: 'Marketplace plugin registry entry is invalid.',
            issues: [{ path: 'entry', message: 'entry is required.' }],
        };
    }
    return { ok: true, entry: validated };
}
function sourceUrlFromEntry(entry) {
    return typeof entry?.source === 'string' ? entry.source.trim() : '';
}
