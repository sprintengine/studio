import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isClaudeCodePluginEntry, validateMarketplaceIndex } from '../../shared/marketplace';
import { SKILL_HARNESS_DIR, SKILL_PACK_HARNESSES } from '../../shared/skill-harnesses';
import { uninstallSkill } from '../skills/install';
import { installMarketplacePlugin } from '../modules/plugin-bundle-installer';
import { normalizeMcpClients, normalizeMcpServerConfig } from '../mcp-config-service';
import { defaultUserModuleRoot, moduleInstallPath } from '../modules/user-module-registry';
import { getPluginRegistryUserRoot, reloadPluginRegistry } from '../plugin-registry-instance';
import { defaultMarketplacePluginStagingRoot, downloadClaudeCodePluginSource, downloadMarketplacePluginBundle, } from './plugin-download';
export const MARKETPLACE_PLUGIN_INSTALLS_FILENAME = 'marketplace-plugin-installs.json';
const RECEIPT_COMPONENT_KINDS = new Set(['mcp', 'skills', 'module', 'cli', 'automation']);
const MODULE_TRUST_STATUSES = new Set(['trusted', 'signed', 'unsigned', 'invalid']);
export function defaultMarketplacePluginInstallStorePath(userDataDir) {
    return join(userDataDir, MARKETPLACE_PLUGIN_INSTALLS_FILENAME);
}
export function createMarketplacePluginLifecycleService(services) {
    return {
        installFromRegistry: (input) => installOrUpdateMarketplacePlugin(input, services),
        updateFromRegistry: (input) => installOrUpdateMarketplacePlugin(input, services),
        uninstall: (input) => uninstallMarketplacePlugin(input, services),
    };
}
// Read-only view of the install receipts for update detection: the receipt's
// `version` is the bundle version that was installed (guaranteed equal to the
// registry entry's `latest` at install time by the registry-mismatch gate).
export async function readMarketplacePluginInstallReceipts(receiptStorePath) {
    const store = await loadInstallStore(receiptStorePath);
    if (!store.ok)
        return store;
    return { ok: true, receipts: Object.values(store.store.plugins) };
}
export async function installOrUpdateMarketplacePlugin(input, services) {
    const entry = validateRegistryEntry(input.entry);
    if (!entry.ok)
        return { ok: false, message: entry.message, issues: entry.issues };
    const storeResult = await loadInstallStore(services.receiptStorePath);
    if (!storeResult.ok)
        return { ok: false, message: storeResult.message };
    const store = storeResult.store;
    const previous = store.plugins[entry.entry.id];
    // Inline-MCP entries carry server configs directly (no bundle to download).
    // Route them through the MCP config sync behind the same trust gate.
    if (entry.entry.mcp) {
        return installInlineMcpEntry(entry.entry, input, services, store, previous);
    }
    // Claude Code plugins are not Multicode bundles: their content is Claude's
    // plugin format, so they route through the claude-plugin adapter (skills
    // copied into workspace harness dirs) behind the same unsigned trust gate.
    if (isClaudeCodePluginEntry(entry.entry)) {
        return installClaudeCodePluginEntry(entry.entry, input, services, store, previous);
    }
    const download = await downloadMarketplacePluginBundle({
        entry: entry.entry,
        trustContext: services.trustContext(),
        stagingRoot: services.stagingRoot ?? defaultMarketplacePluginStagingRoot(dirname(services.receiptStorePath)),
        fetcher: services.fetcher,
    });
    if (!download.ok) {
        return {
            ok: false,
            message: download.message,
            sourceUrl: download.sourceUrl,
            classification: download.classification,
            trust: download.trust?.status,
            loadEligible: false,
            issues: download.issues,
            updated: Boolean(previous),
        };
    }
    // Community (signed, unverified publisher) and unsigned (mcp/skills-only)
    // bundles both require the server-side trust grant before install. Unsigned
    // code-bearing bundles never reach here: download hard-blocks them.
    if ((download.classification === 'community' || download.classification === 'unsigned') &&
        input.trustGranted !== true) {
        await rm(download.stagedBundlePath, { recursive: true, force: true });
        return {
            ok: false,
            sourceUrl: download.sourceUrl,
            classification: download.classification,
            trust: download.trust.status,
            loadEligible: download.loadEligible,
            updated: Boolean(previous),
            message: download.classification === 'unsigned'
                ? 'Unsigned marketplace plugin requires trust approval before install.'
                : 'Community marketplace plugin requires trust approval before install.',
            issues: [{ path: 'signature', message: 'Grant trust in the marketplace trust gate before installing this plugin.' }],
        };
    }
    const installClassification = download.classification === 'verified'
        ? 'verified'
        : download.classification === 'unsigned'
            ? 'unsigned'
            : 'community';
    const backupRoot = join(dirname(download.stagedBundlePath), `${entry.entry.id}-previous-${Date.now()}`);
    try {
        const previousSnapshot = previous
            ? await createPreviousInstallSnapshot(previous, input, services, backupRoot)
            : { ok: true, snapshot: undefined };
        if (!previousSnapshot.ok) {
            return {
                ok: false,
                message: `Could not snapshot previous marketplace plugin install: ${previousSnapshot.message}`,
                sourceUrl: download.sourceUrl,
                classification: installClassification,
                trust: download.trust.status,
                loadEligible: download.loadEligible,
                updated: true,
            };
        }
        const installInput = {
            localFolder: download.stagedBundlePath,
            workspaceRoot: input.workspaceRoot,
            mcpSettings: input.mcpSettings,
            mcpClients: input.mcpClients,
            skillHarnesses: input.skillHarnesses,
            ...(input.automationDefaultCli ? { automationDefaultCli: input.automationDefaultCli } : {}),
        };
        const installed = await installMarketplacePlugin(installInput, services);
        if (!installed.ok) {
            const rollback = await rollbackInstalledComponents(entry.entry.id, installed.installed ?? [], input, services, input.mcpSettings);
            const restored = previousSnapshot.snapshot
                ? await restorePreviousInstallSnapshot(previousSnapshot.snapshot, input, services)
                : { ok: true };
            return appendRestoreFailure(appendRollbackFailure({
                ...installed,
                sourceUrl: download.sourceUrl,
                classification: download.classification,
                updated: Boolean(previous),
            }, rollback), restored);
        }
        const receipt = {
            id: installed.id,
            displayName: installed.displayName,
            version: installed.version,
            sourceUrl: download.sourceUrl,
            classification: installClassification,
            installedAt: new Date().toISOString(),
            components: installed.installed,
        };
        let finalMcpSettings = installed.mcpSettings ?? input.mcpSettings;
        if (previous) {
            const staleComponents = componentsWithoutOverlap(previous.components, receipt.components);
            if (staleComponents.length > 0) {
                const removed = await uninstallReceipt({ ...previous, components: staleComponents }, { ...input, pluginId: previous.id, mcpSettings: finalMcpSettings }, services);
                if (!removed.ok) {
                    const rollback = await rollbackInstalledComponents(receipt.id, componentsWithoutOverlap(receipt.components, previous.components), { ...input, mcpSettings: finalMcpSettings }, services, finalMcpSettings);
                    const restored = previousSnapshot.snapshot
                        ? await restorePreviousInstallSnapshot(previousSnapshot.snapshot, input, services)
                        : { ok: true };
                    return appendRestoreFailure(appendRollbackFailure({
                        ok: false,
                        message: `Could not remove previous marketplace plugin components: ${removed.message}`,
                        sourceUrl: download.sourceUrl,
                        classification: installClassification,
                        trust: installed.trust,
                        loadEligible: installed.loadEligible,
                        installed: receipt.components,
                        updated: true,
                    }, rollback), restored);
                }
                finalMcpSettings = removed.mcpSettings ?? finalMcpSettings;
            }
        }
        // Marketplace trust grant — only now, after every component installed and
        // stale components were removed: a failed later component rolls files back,
        // so no grant may precede full success. The install-prompt trust decision
        // IS the module trust decision, so a signed module component no longer
        // lands awaiting a second, identical toggle in Settings → Modules. Bound to
        // the installed manifest fingerprint, so different bytes under the same id
        // never inherit it. Only the community tier reaches here with a grant:
        // verified installs never ask for one, and an unsigned bundle carrying a
        // module is refused at the signature gate.
        const granted = await grantModuleComponentTrust(receipt.components, input, services, installClassification);
        store.plugins[receipt.id] = receipt;
        try {
            await writeInstallStore(services.receiptStorePath, store);
        }
        catch (error) {
            const rollback = await rollbackInstalledComponents(receipt.id, receipt.components, input, services, finalMcpSettings);
            const restored = previousSnapshot.snapshot
                ? await restorePreviousInstallSnapshot(previousSnapshot.snapshot, input, services)
                : { ok: true };
            // Last, so the rollback's own module revocations cannot undo it: the
            // trust store ends exactly as it was before this install.
            const trustRestored = await restoreModuleComponentTrust(granted, services);
            return appendTrustRestoreFailure(appendRestoreFailure(appendRollbackFailure({
                ok: false,
                message: `Could not write marketplace plugin install receipt: ${formatError(error)}`,
                sourceUrl: download.sourceUrl,
                classification: installClassification,
                trust: installed.trust,
                loadEligible: installed.loadEligible,
                installed: receipt.components,
                updated: Boolean(previous),
            }, rollback), restored), trustRestored);
        }
        return {
            ...installed,
            ...(finalMcpSettings ? { mcpSettings: finalMcpSettings } : {}),
            sourceUrl: download.sourceUrl,
            classification: installClassification,
            updated: Boolean(previous),
        };
    }
    finally {
        await rm(download.stagedBundlePath, { recursive: true, force: true });
        await rm(backupRoot, { recursive: true, force: true });
    }
}
// Install an inline-MCP registry entry: the servers ship in the entry itself,
// so there is no bundle to download, verify, or sign. Because MCP config is
// code-execution config written to agent CLIs, this NEVER installs without the
// server-side trust grant, and is recorded with an honest 'unsigned' receipt.
async function installInlineMcpEntry(entry, input, services, store, previous) {
    const updated = Boolean(previous);
    if (input.trustGranted !== true) {
        return {
            ok: false,
            sourceUrl: '',
            classification: 'unsigned',
            trust: 'unsigned',
            loadEligible: false,
            updated,
            message: 'Inline MCP marketplace entry requires trust approval before install.',
            issues: [{ path: 'mcp', message: 'Grant trust in the marketplace trust gate before installing this MCP server.' }],
        };
    }
    const workspaceRoot = input.workspaceRoot?.trim();
    if (!workspaceRoot) {
        return { ok: false, sourceUrl: '', classification: 'unsigned', updated, message: 'Workspace root is required to install inline MCP marketplace entries.' };
    }
    const servers = [];
    for (const raw of entry.mcp?.servers ?? []) {
        const normalized = normalizeMcpServerConfig(raw, {
            enabled: true,
            scope: 'workspace',
            source: 'custom',
            clients: input.mcpClients?.length ? input.mcpClients : undefined,
        });
        if (!normalized) {
            return {
                ok: false,
                sourceUrl: '',
                classification: 'unsigned',
                updated,
                message: 'Inline MCP marketplace entry contains an invalid server configuration.',
                issues: [{ path: 'mcp.servers', message: 'MCP server did not normalize through the app MCP parser.' }],
            };
        }
        servers.push(normalized);
    }
    if (servers.length === 0) {
        return { ok: false, sourceUrl: '', classification: 'unsigned', updated, message: 'Inline MCP marketplace entry declares no servers.' };
    }
    const backupRoot = join(dirname(services.receiptStorePath), `${entry.id}-inline-previous-${Date.now()}`);
    try {
        const previousSnapshot = previous
            ? await createPreviousInstallSnapshot(previous, input, services, backupRoot)
            : { ok: true, snapshot: undefined };
        if (!previousSnapshot.ok) {
            return { ok: false, sourceUrl: '', classification: 'unsigned', updated, message: `Could not snapshot previous marketplace plugin install: ${previousSnapshot.message}` };
        }
        const nextSettings = {
            syncEnabled: true,
            servers: {
                ...(input.mcpSettings?.servers ?? {}),
                ...Object.fromEntries(servers.map((server) => [server.id, server])),
            },
        };
        const clients = normalizeMcpClients(input.mcpClients?.length ? input.mcpClients : servers.flatMap((server) => server.clients));
        const sync = services.mcpConfigService.sync({ workspaceRoot, settings: nextSettings, clients, write: true });
        if (!sync.ok) {
            const restored = previousSnapshot.snapshot
                ? await restorePreviousInstallSnapshot(previousSnapshot.snapshot, input, services)
                : { ok: true };
            const issues = mcpSyncIssuesToMarketplaceIssues(sync.issues);
            return appendRestoreFailure({
                ok: false,
                sourceUrl: '',
                classification: 'unsigned',
                updated,
                message: sync.message,
                ...(issues ? { issues } : {}),
            }, restored);
        }
        const receipt = {
            id: entry.id,
            displayName: entry.name,
            version: entry.latest,
            sourceUrl: '',
            classification: 'unsigned',
            installedAt: new Date().toISOString(),
            components: [installedInlineMcpComponent(servers)],
        };
        let finalMcpSettings = nextSettings;
        if (previous) {
            const stale = componentsWithoutOverlap(previous.components, receipt.components);
            if (stale.length > 0) {
                const removed = await uninstallReceipt({ ...previous, components: stale }, { ...input, pluginId: previous.id, mcpSettings: finalMcpSettings }, services);
                if (!removed.ok) {
                    const rollback = await rollbackInstalledComponents(receipt.id, receipt.components, { ...input, mcpSettings: finalMcpSettings }, services, finalMcpSettings);
                    const restored = previousSnapshot.snapshot
                        ? await restorePreviousInstallSnapshot(previousSnapshot.snapshot, input, services)
                        : { ok: true };
                    return appendRestoreFailure(appendRollbackFailure({
                        ok: false,
                        sourceUrl: '',
                        classification: 'unsigned',
                        trust: 'unsigned',
                        loadEligible: false,
                        installed: receipt.components,
                        updated: true,
                        message: `Could not remove previous marketplace plugin components: ${removed.message}`,
                    }, rollback), restored);
                }
                finalMcpSettings = removed.mcpSettings ?? finalMcpSettings;
            }
        }
        store.plugins[receipt.id] = receipt;
        try {
            await writeInstallStore(services.receiptStorePath, store);
        }
        catch (error) {
            const rollback = await rollbackInstalledComponents(receipt.id, receipt.components, input, services, finalMcpSettings);
            const restored = previousSnapshot.snapshot
                ? await restorePreviousInstallSnapshot(previousSnapshot.snapshot, input, services)
                : { ok: true };
            return appendRestoreFailure(appendRollbackFailure({
                ok: false,
                sourceUrl: '',
                classification: 'unsigned',
                trust: 'unsigned',
                loadEligible: false,
                installed: receipt.components,
                updated,
                message: `Could not write marketplace plugin install receipt: ${formatError(error)}`,
            }, rollback), restored);
        }
        return {
            ok: true,
            id: receipt.id,
            displayName: receipt.displayName,
            version: receipt.version,
            trust: 'unsigned',
            loadEligible: false,
            installed: receipt.components,
            mcpSettings: finalMcpSettings,
            sourceUrl: '',
            classification: 'unsigned',
            updated,
        };
    }
    finally {
        await rm(backupRoot, { recursive: true, force: true });
    }
}
// Claude Code plugins install by copying each staged `skills/<dir>` into the
// workspace's harness skill dirs — the same surface the driving-skill install
// uses, so the skills appear in the workspace inventory and skill pickers.
// SKILL.md content is harness-portable, so the default target set is resolved
// via services.resolveSkillHarnesses (shared `.agents` + every installed CLI
// with native skill support); input.skillHarnesses overrides, and this
// Claude-only constant is the last-resort fallback when no resolver is wired.
// Commands/agents in the plugin are not installed — skills are the one
// component Multicode delivers.
const DEFAULT_CLAUDE_PLUGIN_HARNESSES = ['claude'];
function previousHarnesses(previous) {
    const harnesses = new Set();
    for (const component of previous?.components ?? []) {
        if (component.kind !== 'skills')
            continue;
        for (const harness of component.harnesses ?? [])
            harnesses.add(harness);
    }
    return [...harnesses];
}
async function resolveInstallHarnesses(input, services, previous) {
    // An explicit caller set is authoritative — a deliberate narrowing may
    // legitimately drop harness copies (the stale sweep handles it).
    if (input.skillHarnesses?.length)
        return input.skillHarnesses;
    let resolved = DEFAULT_CLAUDE_PLUGIN_HARNESSES;
    if (services.resolveSkillHarnesses) {
        // A resolver failure or empty set must not turn the install into a
        // silent no-op writing nowhere — fall back to the Claude-only default.
        try {
            const set = await services.resolveSkillHarnesses();
            if (set.length > 0)
                resolved = set;
        }
        catch {
            // fall through to the default
        }
    }
    // Auto-resolution must never REMOVE a harness a previous install owned: a
    // transient CLI-probe hiccup (or resolver error) would otherwise narrow the
    // set and make the stale sweep permanently delete still-wanted skill copies
    // from CLIs that are actually still installed. Union with the prior set so
    // an auto-resolved update is only ever additive; a genuinely-removed CLI
    // keeps its harmless copy until an explicit skillHarnesses narrows it.
    const union = new Set([...resolved, ...previousHarnesses(previous)]);
    return SKILL_PACK_HARNESSES.filter((harness) => union.has(harness));
}
async function installClaudeCodePluginEntry(entry, input, services, store, previous) {
    const updated = Boolean(previous);
    const sourceUrl = entry.source?.trim() ?? '';
    if (input.trustGranted !== true) {
        return {
            ok: false,
            sourceUrl,
            classification: 'unsigned',
            trust: 'unsigned',
            loadEligible: false,
            updated,
            message: 'Claude Code plugin requires trust approval before install.',
            issues: [{ path: 'source', message: 'Grant trust in the marketplace trust gate before installing this plugin.' }],
        };
    }
    const workspaceRoot = input.workspaceRoot?.trim();
    if (!workspaceRoot) {
        return { ok: false, sourceUrl, classification: 'unsigned', updated, message: 'Workspace root is required to install Claude Code plugin skills.' };
    }
    services.log?.('claude-plugin:install-start', { entryId: entry.id });
    const download = await downloadClaudeCodePluginSource({
        entry,
        stagingRoot: services.stagingRoot ?? defaultMarketplacePluginStagingRoot(dirname(services.receiptStorePath)),
        packagedResourceResolver: services.packagedResourceResolver,
        log: services.log,
        // Install exactly what the trust prompt disclosed when the verify pin is
        // present; otherwise the staging computes the content identity itself.
        ...(input.claudePluginRef ? { refOverride: input.claudePluginRef } : {}),
    });
    if (!download.ok) {
        services.log?.('claude-plugin:install-failed', { entryId: entry.id, message: download.message });
        return {
            ok: false,
            sourceUrl: download.sourceUrl,
            classification: 'unsigned',
            updated,
            message: download.message,
            issues: [{ path: 'source', message: download.message }],
        };
    }
    const harnesses = await resolveInstallHarnesses(input, services, previous);
    // Ownership is per dir AND per harness: a previous install owning "foo" in
    // .claude says nothing about a hand-authored .agents/skills/foo.
    const previousHarnessesByDir = new Map();
    for (const component of previous?.components ?? []) {
        if (component.kind !== 'skills')
            continue;
        const dir = component.installedDirName ?? component.id;
        const owned = previousHarnessesByDir.get(dir) ?? new Set();
        for (const harness of component.harnesses ?? [])
            owned.add(harness);
        previousHarnessesByDir.set(dir, owned);
    }
    const backupRoot = join(dirname(services.receiptStorePath), `${entry.id}-claude-previous-${Date.now()}`);
    try {
        // Pre-flight: never silently clobber a skill dir this plugin does not own
        // (a hand-dropped custom skill or another pack sharing the name) — checked
        // per harness, so widening the harness set cannot skip the check.
        for (const dir of download.skillDirs) {
            for (const harness of harnesses) {
                if (previousHarnessesByDir.get(dir)?.has(harness))
                    continue;
                const target = join(workspaceRoot, SKILL_HARNESS_DIR[harness], 'skills', dir);
                if (await pathExists(target)) {
                    return {
                        ok: false,
                        sourceUrl,
                        classification: 'unsigned',
                        updated,
                        message: `A skill folder named "${dir}" already exists in ${SKILL_HARNESS_DIR[harness]}/skills and is not owned by this plugin. Remove or rename it, then install again.`,
                    };
                }
            }
        }
        const previousSnapshot = previous
            ? await createPreviousInstallSnapshot(previous, input, services, backupRoot)
            : { ok: true, snapshot: undefined };
        if (!previousSnapshot.ok) {
            return { ok: false, sourceUrl, classification: 'unsigned', updated, message: `Could not snapshot previous marketplace plugin install: ${previousSnapshot.message}` };
        }
        const components = [];
        for (const dir of download.skillDirs) {
            // Count each harness BEFORE its copy starts so a mid-copy failure still
            // rolls back the partially written target — an untracked partial dir
            // would otherwise survive as an orphan the next install refuses over.
            const attempted = [];
            try {
                for (const harness of harnesses) {
                    attempted.push(harness);
                    const target = join(workspaceRoot, SKILL_HARNESS_DIR[harness], 'skills', dir);
                    await mkdir(dirname(target), { recursive: true });
                    await cp(join(download.stagedPath, 'skills', dir), target, { recursive: true, force: true });
                }
            }
            catch (error) {
                services.log?.('claude-plugin:copy-failed', { entryId: entry.id, skill: dir, message: formatError(error) });
                const partial = {
                    kind: 'skills',
                    id: dir,
                    installedDirName: dir,
                    harnesses: attempted,
                    message: 'Partial copy rolled back.',
                };
                const rollback = await rollbackInstalledComponents(entry.id, [...components, partial], input, services, input.mcpSettings);
                const restored = previousSnapshot.snapshot
                    ? await restorePreviousInstallSnapshot(previousSnapshot.snapshot, input, services)
                    : { ok: true };
                return appendRestoreFailure(appendRollbackFailure({
                    ok: false,
                    sourceUrl,
                    classification: 'unsigned',
                    trust: 'unsigned',
                    loadEligible: false,
                    installed: components,
                    updated,
                    message: `Could not copy plugin skill "${dir}": ${formatError(error)}`,
                }, rollback), restored);
            }
            components.push({
                kind: 'skills',
                id: dir,
                installedDirName: dir,
                harnesses,
                message: `Installed for ${harnesses.join(', ')}.`,
            });
        }
        const receipt = {
            id: entry.id,
            displayName: entry.name,
            version: entry.latest,
            sourceUrl,
            classification: 'unsigned',
            installedAt: new Date().toISOString(),
            components,
        };
        if (previous) {
            // Stale = previous skill dirs the new install no longer ships, PLUS —
            // because componentsOverlap keys skills on dir name only — the harness
            // copies a still-shipped dir no longer targets (else a harness change
            // would strand untracked copies forever).
            const staleDirs = componentsWithoutOverlap(previous.components, receipt.components);
            const staleHarnessCopies = (previous.components ?? [])
                .filter((component) => component.kind === 'skills')
                .flatMap((component) => {
                const dir = component.installedDirName ?? component.id;
                if (!download.skillDirs.includes(dir))
                    return []; // whole dir already stale above
                const removedHarnesses = (component.harnesses ?? []).filter((harness) => !harnesses.includes(harness));
                return removedHarnesses.length > 0 ? [{ ...component, harnesses: removedHarnesses }] : [];
            });
            const stale = [...staleDirs, ...staleHarnessCopies];
            if (stale.length > 0) {
                const removed = await uninstallReceipt({ ...previous, components: stale }, { ...input, pluginId: previous.id }, services);
                if (!removed.ok) {
                    const rollback = await rollbackInstalledComponents(receipt.id, receipt.components, input, services, input.mcpSettings);
                    const restored = previousSnapshot.snapshot
                        ? await restorePreviousInstallSnapshot(previousSnapshot.snapshot, input, services)
                        : { ok: true };
                    return appendRestoreFailure(appendRollbackFailure({
                        ok: false,
                        sourceUrl,
                        classification: 'unsigned',
                        trust: 'unsigned',
                        loadEligible: false,
                        installed: receipt.components,
                        updated: true,
                        message: `Could not remove previous marketplace plugin components: ${removed.message}`,
                    }, rollback), restored);
                }
            }
        }
        store.plugins[receipt.id] = receipt;
        try {
            await writeInstallStore(services.receiptStorePath, store);
        }
        catch (error) {
            const rollback = await rollbackInstalledComponents(receipt.id, receipt.components, input, services, input.mcpSettings);
            const restored = previousSnapshot.snapshot
                ? await restorePreviousInstallSnapshot(previousSnapshot.snapshot, input, services)
                : { ok: true };
            return appendRestoreFailure(appendRollbackFailure({
                ok: false,
                sourceUrl,
                classification: 'unsigned',
                trust: 'unsigned',
                loadEligible: false,
                installed: receipt.components,
                updated,
                message: `Could not write marketplace plugin install receipt: ${formatError(error)}`,
            }, rollback), restored);
        }
        services.log?.('claude-plugin:install-ok', {
            entryId: entry.id,
            skills: receipt.components.length,
            harnesses,
            updated,
        });
        const notices = download.metadataOnlySkills.length > 0
            ? [
                `${download.metadataOnlySkills.length} skill${download.metadataOnlySkills.length === 1 ? '' : 's'} in this plugin (${download.metadataOnlySkills.join(', ')}) ${download.metadataOnlySkills.length === 1 ? 'ships' : 'ship'} without bundled content and ${download.metadataOnlySkills.length === 1 ? 'was' : 'were'} not installed.`,
            ]
            : [];
        return {
            ok: true,
            id: receipt.id,
            displayName: receipt.displayName,
            version: receipt.version,
            trust: 'unsigned',
            loadEligible: false,
            installed: receipt.components,
            ...(notices.length > 0 ? { notices } : {}),
            sourceUrl,
            classification: 'unsigned',
            updated,
        };
    }
    finally {
        await rm(download.stagedPath, { recursive: true, force: true }).catch(() => undefined);
        await rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
    }
}
// Record the install-prompt trust decision against each signed module the
// bundle just installed. Mutates each component's receipt message so the user
// is told what actually happened, including when the trust write failed and the
// module is installed but still awaiting a Settings toggle.
async function grantModuleComponentTrust(components, input, services, classification) {
    const granted = [];
    if (input.trustGranted !== true || !services.setModuleTrust || classification !== 'community')
        return granted;
    for (const component of components) {
        // 'signed' is the only status a grant changes: 'trusted' already loads
        // (first-party publisher key, or an existing grant for these exact bytes).
        // A module whose OWN manifest carries no signature stays awaiting-trust in
        // Settings — the bundle signature covers its bytes, but the module identity
        // a grant binds to is the one the module itself signs.
        if (component.kind !== 'module' || component.trustStatus !== 'signed' || !component.manifestFp)
            continue;
        const grant = await services.setModuleTrust(component.id, component.manifestFp);
        if (grant.ok) {
            granted.push({ id: component.id, previous: grant.previous ?? null });
            component.message = 'Installed and trusted; loads on the next app launch.';
        }
        else {
            component.message = `Installed, but recording trust failed (${grant.message ?? 'unknown error'}); trust it from Settings → Modules.`;
        }
    }
    return granted;
}
// Put back what each id mapped to before the grant. A restore that itself
// fails leaves a module trusted whose files were just rolled back, so it is
// named in the failure message rather than swallowed.
async function restoreModuleComponentTrust(granted, services) {
    const failed = [];
    for (const entry of granted) {
        const restore = await services.setModuleTrust?.(entry.id, entry.previous);
        if (restore && !restore.ok)
            failed.push(`${entry.id} (${restore.message ?? 'unknown error'})`);
    }
    if (failed.length === 0)
        return { ok: true };
    return {
        ok: false,
        message: `Trust granted during this install could not be taken back for ${failed.join('; ')}. Review these modules in Settings → Modules.`,
    };
}
function installedInlineMcpComponent(servers) {
    return {
        kind: 'mcp',
        id: servers.map((server) => server.id).join(','),
        serverIds: servers.map((server) => server.id),
        servers,
        message: `Synced ${servers.length} inline MCP server${servers.length === 1 ? '' : 's'}.`,
    };
}
function mcpSyncIssuesToMarketplaceIssues(issues) {
    if (!issues?.length)
        return undefined;
    return issues.map((issue) => ({
        path: issue.serverId ? `servers.${issue.serverId}` : issue.client ? `clients.${issue.client}` : '',
        message: issue.message,
    }));
}
export async function uninstallMarketplacePlugin(input, services) {
    const pluginId = input.pluginId?.trim();
    if (!pluginId)
        return { ok: false, message: 'Plugin id is required.' };
    const storeResult = await loadInstallStore(services.receiptStorePath);
    if (!storeResult.ok)
        return { ok: false, message: storeResult.message };
    const store = storeResult.store;
    const receipt = store.plugins[pluginId];
    if (!receipt)
        return { ok: false, message: `Marketplace plugin ${pluginId} is not installed.` };
    const result = await uninstallReceipt(receipt, input, services);
    if (!result.ok)
        return result;
    delete store.plugins[pluginId];
    await writeInstallStore(services.receiptStorePath, store);
    return result;
}
async function uninstallReceipt(receipt, input, services, 
// Removing a module for good retracts its trust decision; undoing a failed
// install must NOT — the files being rolled back may be replacing a module
// the user trusted earlier, which the snapshot restore is about to put back.
options = {}) {
    const revokeModuleTrust = options.revokeModuleTrust ?? true;
    const removed = [];
    let nextMcpSettings = input.mcpSettings;
    for (const component of [...receipt.components].reverse()) {
        try {
            switch (component.kind) {
                case 'mcp':
                    nextMcpSettings = removeMcpComponent(component, input, services, nextMcpSettings);
                    break;
                case 'skills':
                    await removeSkillComponent(component, input);
                    break;
                case 'module':
                    await rm(moduleInstallPath((services.moduleRoot ?? defaultUserModuleRoot)(), component.id), { recursive: true, force: true });
                    // An orphaned id→fingerprint entry would silently re-trust the same
                    // bytes if they ever came back via a folder drop or another bundle —
                    // so a failed revoke fails the uninstall (the receipt survives and
                    // the retry is idempotent) rather than leaving that entry unseen.
                    if (revokeModuleTrust && services.setModuleTrust) {
                        const revoked = await services.setModuleTrust(component.id, null);
                        if (!revoked.ok) {
                            throw new Error(`Removed module "${component.id}" but could not withdraw its trust: ${revoked.message ?? 'unknown error'}`);
                        }
                    }
                    break;
                case 'cli':
                    await rm(join((services.pluginRoot ?? getPluginRegistryUserRoot)(), component.id), { recursive: true, force: true });
                    {
                        const reloadPlugins = services.reloadPlugins ?? reloadPluginRegistry;
                        reloadPlugins();
                    }
                    break;
                case 'automation':
                    // Deliberately left in place (owner ruling): an added automation is
                    // the user's from the moment it lands — they name it, edit it, and
                    // schedule it against their own repo. Silently deleting a scheduled
                    // job because the plugin that shipped its starter went away is worse
                    // than leaving a record they can see and remove themselves.
                    break;
            }
            removed.push(component);
        }
        catch (error) {
            return {
                ok: false,
                message: error instanceof Error ? error.message : String(error),
                removed,
                ...(nextMcpSettings ? { mcpSettings: nextMcpSettings } : {}),
            };
        }
    }
    return {
        ok: true,
        id: receipt.id,
        removed,
        ...(nextMcpSettings ? { mcpSettings: nextMcpSettings } : {}),
    };
}
function removeMcpComponent(component, input, services, currentSettings) {
    const workspaceRoot = input.workspaceRoot?.trim();
    if (!workspaceRoot)
        throw new Error('Workspace root is required to uninstall MCP components.');
    const serverIds = component.serverIds?.length ? component.serverIds : component.id.split(',').map((id) => id.trim()).filter(Boolean);
    const currentServers = { ...(currentSettings?.servers ?? {}) };
    const disabledServers = {};
    for (const serverId of serverIds) {
        const server = currentServers[serverId] ?? component.servers?.find((candidate) => candidate.id === serverId);
        delete currentServers[serverId];
        if (server)
            disabledServers[serverId] = { ...server, enabled: false };
    }
    const syncSettings = {
        syncEnabled: currentSettings?.syncEnabled ?? true,
        servers: { ...currentServers, ...disabledServers },
    };
    const clients = input.mcpClients?.length ? input.mcpClients : clientsFromServers(Object.values(disabledServers));
    const result = services.mcpConfigService.sync({
        workspaceRoot,
        settings: syncSettings,
        clients,
        write: true,
    });
    if (!result.ok)
        throw new Error(result.message);
    return {
        syncEnabled: currentSettings?.syncEnabled ?? true,
        servers: currentServers,
    };
}
async function removeSkillComponent(component, input) {
    const workspaceRoot = input.workspaceRoot?.trim();
    if (!workspaceRoot)
        throw new Error('Workspace root is required to uninstall skill components.');
    const dirName = component.installedDirName ?? component.id;
    const result = await uninstallSkill({
        workspaceRoot,
        dirName,
        // The receipt names the harnesses the install wrote; without one, every
        // harness dir is swept rather than guessing which held a copy.
        harnesses: component.harnesses?.length
            ? component.harnesses
            : input.skillHarnesses?.length
                ? input.skillHarnesses
                : SKILL_PACK_HARNESSES,
    });
    // Already gone is the state uninstall wants, so an empty sweep is fine here;
    // only a real failure is one.
    if (!result.ok)
        throw new Error(result.message);
}
function clientsFromServers(servers) {
    const clients = servers.flatMap((server) => server.clients);
    return clients.length ? Array.from(new Set(clients)) : ['codex', 'claude-code'];
}
async function createPreviousInstallSnapshot(receipt, input, services, backupRoot) {
    try {
        const filesystem = [];
        for (const originalPath of filesystemComponentPaths(receipt.components, input, services)) {
            const backupPath = join(backupRoot, String(filesystem.length));
            const existed = await pathExists(originalPath);
            if (existed) {
                await mkdir(dirname(backupPath), { recursive: true });
                await cp(originalPath, backupPath, { recursive: true, force: true });
            }
            filesystem.push({ originalPath, backupPath, existed });
        }
        return {
            ok: true,
            snapshot: {
                filesystem,
                mcpSettings: previousMcpSettings(receipt.components, input.mcpSettings),
            },
        };
    }
    catch (error) {
        return { ok: false, message: formatError(error) };
    }
}
async function restorePreviousInstallSnapshot(snapshot, input, services) {
    try {
        for (const backup of [...snapshot.filesystem].reverse()) {
            await rm(backup.originalPath, { recursive: true, force: true });
            if (!backup.existed)
                continue;
            await mkdir(dirname(backup.originalPath), { recursive: true });
            await cp(backup.backupPath, backup.originalPath, { recursive: true, force: true });
        }
        const workspaceRoot = input.workspaceRoot?.trim();
        if (snapshot.mcpSettings && workspaceRoot) {
            const servers = Object.values(snapshot.mcpSettings.servers);
            const result = services.mcpConfigService.sync({
                workspaceRoot,
                settings: snapshot.mcpSettings,
                clients: input.mcpClients?.length ? input.mcpClients : clientsFromServers(servers),
                write: true,
            });
            if (!result.ok)
                return { ok: false, message: result.message };
        }
        return { ok: true };
    }
    catch (error) {
        return { ok: false, message: formatError(error) };
    }
}
function filesystemComponentPaths(components, input, services) {
    const paths = [];
    for (const component of components) {
        switch (component.kind) {
            case 'skills':
                paths.push(...skillComponentPaths(component, input));
                break;
            case 'module':
                paths.push(moduleInstallPath((services.moduleRoot ?? defaultUserModuleRoot)(), component.id));
                break;
            case 'cli':
                paths.push(join((services.pluginRoot ?? getPluginRegistryUserRoot)(), component.id));
                break;
            case 'mcp':
            // An automation is a store record, not a path, and an update never
            // rewrites it: the receipt's id keeps pointing at the record the first
            // install created, so there is nothing to snapshot or restore.
            case 'automation':
                break;
        }
    }
    return Array.from(new Set(paths));
}
function skillComponentPaths(component, input) {
    const workspaceRoot = input.workspaceRoot?.trim();
    if (!workspaceRoot)
        return [];
    const dirName = component.installedDirName ?? component.id;
    const harnesses = component.harnesses?.length ? component.harnesses : input.skillHarnesses?.length ? input.skillHarnesses : ['agents'];
    return harnesses.map((harness) => join(workspaceRoot, harness === 'agents' ? '.agents' : `.${harness}`, 'skills', dirName));
}
function previousMcpSettings(components, currentSettings) {
    const mcpComponents = components.filter((component) => component.kind === 'mcp');
    if (mcpComponents.length === 0)
        return undefined;
    const servers = { ...(currentSettings?.servers ?? {}) };
    for (const component of mcpComponents) {
        for (const server of component.servers ?? []) {
            servers[server.id] = { ...server, enabled: server.enabled ?? true };
        }
    }
    return {
        syncEnabled: currentSettings?.syncEnabled ?? true,
        servers,
    };
}
async function pathExists(path) {
    try {
        await stat(path);
        return true;
    }
    catch (error) {
        if (isMissingFileError(error))
            return false;
        throw error;
    }
}
async function rollbackInstalledComponents(pluginId, components, input, services, mcpSettings) {
    if (components.length === 0)
        return { ok: true };
    const rollback = await uninstallReceipt({
        id: pluginId,
        displayName: pluginId,
        version: 0,
        sourceUrl: '',
        classification: 'community',
        installedAt: new Date().toISOString(),
        components,
    }, { ...input, pluginId, mcpSettings }, services, { revokeModuleTrust: false });
    if (rollback.ok)
        return { ok: true };
    return { ok: false, message: rollback.message };
}
function appendRollbackFailure(result, rollback) {
    if (rollback.ok)
        return result;
    return {
        ...result,
        message: `${result.message} Rollback after failed marketplace install also failed: ${rollback.message}`,
    };
}
function appendTrustRestoreFailure(result, trustRestore) {
    if (trustRestore.ok)
        return result;
    return { ...result, message: `${result.message} ${trustRestore.message}` };
}
function appendRestoreFailure(result, restore) {
    if (restore.ok)
        return result;
    return {
        ...result,
        message: `${result.message} Restore of previous marketplace install also failed: ${restore.message}`,
    };
}
function componentsWithoutOverlap(source, keepers) {
    return source.filter((component) => !keepers.some((keeper) => componentsOverlap(component, keeper)));
}
function componentsOverlap(a, b) {
    if (a.kind !== b.kind)
        return false;
    if (a.kind === 'mcp') {
        const aServers = componentServerIds(a);
        const bServers = componentServerIds(b);
        return aServers.some((serverId) => bServers.includes(serverId));
    }
    if (a.kind === 'skills')
        return (a.installedDirName ?? a.id) === (b.installedDirName ?? b.id);
    return a.id === b.id;
}
function componentServerIds(component) {
    return component.serverIds?.length ? component.serverIds : component.id.split(',').map((id) => id.trim()).filter(Boolean);
}
function validateRegistryEntry(entry) {
    const result = validateMarketplaceIndex({ schemaVersion: 1, plugins: [entry] });
    if (!result.ok)
        return { ok: false, message: 'Marketplace plugin registry entry is invalid.', issues: result.issues };
    return { ok: true, entry: result.marketplace.plugins[0] };
}
async function loadInstallStore(path) {
    try {
        return { ok: true, store: validateInstallStore(JSON.parse(await readFile(path, 'utf8'))) };
    }
    catch (error) {
        if (isMissingFileError(error))
            return { ok: true, store: { schemaVersion: 1, plugins: {} } };
        return { ok: false, message: `Marketplace plugin install receipt store is invalid: ${formatError(error)}` };
    }
}
async function writeInstallStore(path, store) {
    validateInstallStore(store);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}
function validateInstallStore(value) {
    if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.plugins)) {
        throw new Error('schemaVersion must be 1 and plugins must be an object.');
    }
    const plugins = {};
    for (const [pluginId, receipt] of Object.entries(value.plugins)) {
        if (!isSafeIdentifier(pluginId))
            throw new Error(`plugins.${pluginId}: plugin id is not safe.`);
        plugins[pluginId] = validateReceipt(receipt, `plugins.${pluginId}`);
    }
    return { schemaVersion: 1, plugins };
}
function validateReceipt(value, path) {
    if (!isRecord(value))
        throw new Error(`${path}: receipt must be an object.`);
    if (!isSafeIdentifier(value.id))
        throw new Error(`${path}.id: id is required and must be a safe identifier.`);
    if (typeof value.displayName !== 'string' || value.displayName.trim().length === 0) {
        throw new Error(`${path}.displayName: displayName is required.`);
    }
    const version = value.version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
        throw new Error(`${path}.version: version must be a non-negative integer.`);
    }
    if (typeof value.sourceUrl !== 'string')
        throw new Error(`${path}.sourceUrl: sourceUrl must be a string.`);
    if (value.classification !== 'verified' && value.classification !== 'community' && value.classification !== 'unsigned') {
        throw new Error(`${path}.classification: classification must be verified, community, or unsigned.`);
    }
    if (typeof value.installedAt !== 'string' || value.installedAt.trim().length === 0) {
        throw new Error(`${path}.installedAt: installedAt is required.`);
    }
    if (!Array.isArray(value.components))
        throw new Error(`${path}.components: components must be an array.`);
    return {
        id: value.id,
        displayName: value.displayName,
        version,
        sourceUrl: value.sourceUrl,
        classification: value.classification,
        installedAt: value.installedAt,
        components: value.components.map((component, index) => validateReceiptComponent(component, `${path}.components[${index}]`)),
    };
}
function validateReceiptComponent(value, path) {
    if (!isRecord(value))
        throw new Error(`${path}: component must be an object.`);
    if (typeof value.kind !== 'string' || !RECEIPT_COMPONENT_KINDS.has(value.kind)) {
        throw new Error(`${path}.kind: unsupported component kind.`);
    }
    if (!isSafeIdentifier(value.id))
        throw new Error(`${path}.id: component id must be safe.`);
    const component = {
        kind: value.kind,
        id: value.id,
        ...(typeof value.message === 'string' ? { message: value.message } : {}),
    };
    if (value.installedDirName !== undefined) {
        if (!isSafeIdentifier(value.installedDirName))
            throw new Error(`${path}.installedDirName: installed directory name must be safe.`);
        component.installedDirName = value.installedDirName;
    }
    if (value.trustStatus !== undefined) {
        if (!MODULE_TRUST_STATUSES.has(value.trustStatus)) {
            throw new Error(`${path}.trustStatus: unsupported module trust status.`);
        }
        component.trustStatus = value.trustStatus;
    }
    if (value.manifestFp !== undefined) {
        if (typeof value.manifestFp !== 'string' || !/^[0-9a-f]{64}$/.test(value.manifestFp)) {
            throw new Error(`${path}.manifestFp: manifest fingerprint must be a sha256 hex digest.`);
        }
        component.manifestFp = value.manifestFp;
    }
    if (value.serverIds !== undefined)
        component.serverIds = validateStringArray(value.serverIds, `${path}.serverIds`, isSafeIdentifier);
    if (value.harnesses !== undefined)
        component.harnesses = validateStringArray(value.harnesses, `${path}.harnesses`, isSafeIdentifier);
    if (value.servers !== undefined) {
        if (!Array.isArray(value.servers))
            throw new Error(`${path}.servers: servers must be an array.`);
        component.servers = value.servers.map((server, index) => {
            if (!isRecord(server) || !isSafeIdentifier(server.id))
                throw new Error(`${path}.servers[${index}].id: server id must be safe.`);
            return server;
        });
    }
    return component;
}
function validateStringArray(value, path, predicate) {
    if (!Array.isArray(value))
        throw new Error(`${path}: must be an array.`);
    return value.map((entry, index) => {
        if (!predicate(entry))
            throw new Error(`${path}[${index}]: value must be a safe string.`);
        return entry;
    });
}
function isSafeIdentifier(value) {
    return typeof value === 'string' &&
        value.trim().length > 0 &&
        !value.includes('\0') &&
        !value.includes('/') &&
        !value.includes('\\') &&
        value !== '.' &&
        value !== '..';
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isMissingFileError(error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}
