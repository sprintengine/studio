import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, delimiter, isAbsolute, join } from 'path';
// Lazy electron so the module is importable from node-only test bundles.
function loadElectron() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('electron');
}
// MCP server-config normalization lives in shared/mcp so node-free consumers
// (the marketplace registry validator) apply identical rules; re-exported here
// to keep this module's public surface stable for existing callers.
import { normalizeMcpClients, normalizeMcpServerConfig, normalizeServer, normalizeStringRecord, } from '../shared/mcp/normalize-server';
import { pluginIdForCli } from './agent-launch-render';
import { getPluginById } from './plugin-registry-instance';
import { STUDIO_MCP_SERVER_ID } from '../shared/product-identity';
export { normalizeMcpClients, normalizeMcpServerConfig };
const MANAGED_START = '# >>> multicode mcp managed';
const MANAGED_END = '# <<< multicode mcp managed';
export const MANAGED_SPRINTENGINE_MCP_SERVER_ID = 'multicode-sprintengine';
const MANAGED_MISSING_COMMAND_PREFIX = '__missing_multicode_sprintengine_mcp__:';
export function createMcpConfigService(options = {}) {
    const lookupPlugin = options.lookupPlugin ?? ((id) => getPluginById(id));
    const homeDir = options.homeDir ?? (() => homedir());
    const userDataDir = options.userDataDir ?? (() => defaultUserDataDir(homeDir));
    const runtimeRoot = options.runtimeRoot ?? findSprintEngineRuntimeRoot;
    return {
        listCatalog,
        previewSync: (input) => syncMcpConfig({ ...input, write: false }, { lookupPlugin, homeDir, userDataDir, runtimeRoot }),
        sync: (input) => syncMcpConfig({ ...input, write: true }, { lookupPlugin, homeDir, userDataDir, runtimeRoot }),
        removeManagedSprintEngine: (input) => removeManagedSprintEngineConfig(input, { lookupPlugin, homeDir, userDataDir, runtimeRoot }),
    };
}
// The bundled catalog is ~100KB of generated JSON (data-URI icons included)
// and immutable for the process lifetime in packaged builds; four renderer
// surfaces re-request it (Connectors open, new-workspace panel, automation
// editor, connector launch), so the sync read+parse+normalize is cached by
// file mtime — dev regenerations still bust it.
let catalogCache = null;
function listCatalog() {
    try {
        const catalogPath = findCatalogPath();
        if (!catalogPath) {
            return { ok: false, message: 'Bundled MCP catalog was not found.' };
        }
        const mtimeMs = statSync(catalogPath).mtimeMs;
        if (catalogCache && catalogCache.path === catalogPath && catalogCache.mtimeMs === mtimeMs) {
            return catalogCache.result;
        }
        const raw = JSON.parse(readFileSync(catalogPath, 'utf8'));
        if (!Array.isArray(raw.servers)) {
            return { ok: false, message: 'Bundled MCP catalog is missing its servers array.' };
        }
        const servers = raw.servers
            .map(normalizeCatalogServer)
            .filter((server) => Boolean(server));
        const result = { ok: true, servers };
        catalogCache = { path: catalogPath, mtimeMs, result };
        return result;
    }
    catch (error) {
        return {
            ok: false,
            message: error instanceof Error ? error.message : 'Unable to read bundled MCP catalog.',
        };
    }
}
function findCatalogPath() {
    const electron = loadElectron();
    const candidates = electron.app.isPackaged
        ? [
            join(process.resourcesPath, 'mcps', 'catalog.json'),
            join(electron.app.getAppPath(), 'resources', 'mcps', 'catalog.json'),
        ]
        : [
            join(process.cwd(), 'resources', 'mcps', 'catalog.json'),
            join(electron.app.getAppPath(), 'resources', 'mcps', 'catalog.json'),
            join(__dirname, '..', '..', 'resources', 'mcps', 'catalog.json'),
            join(__dirname, '..', '..', '..', 'resources', 'mcps', 'catalog.json'),
        ];
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
}
function syncMcpConfig(input, context) {
    const managedServer = buildManagedSprintEngineServer(input);
    const settings = normalizeSettings(input.settings, managedServer);
    const clients = normalizeMcpClients(input.clients);
    const issues = [];
    if (!settings.syncEnabled && !managedServer) {
        return { ok: true, targets: [], issues };
    }
    if (!input.workspaceRoot || !existsSync(input.workspaceRoot)) {
        return { ok: false, message: 'Workspace root does not exist.', issues };
    }
    const activeServers = Object.values(settings.servers)
        .filter((server) => server.enabled)
        .filter((server) => clients.some((client) => server.clients.includes(client)));
    for (const server of activeServers) {
        issues.push(...validateServer(server));
    }
    const blocking = issues.find((issue) => issue.level === 'error');
    if (blocking) {
        return { ok: false, message: blocking.message, issues };
    }
    const targets = [];
    for (const client of clients) {
        const clientServers = activeServers.filter((server) => server.clients.includes(client));
        const knownClientServerIds = Object.values(settings.servers)
            .filter((server) => server.clients.includes(client))
            .map((server) => server.id);
        if (clientServers.length === 0 && knownClientServerIds.length === 0)
            continue;
        const pluginId = pluginIdForCli(client);
        const plugin = context.lookupPlugin(pluginId);
        if (!plugin || !plugin.manifest.mcpConfig) {
            const hasRequired = clientServers.some((server) => server.required);
            issues.push({
                level: hasRequired ? 'error' : 'warning',
                client,
                message: hasRequired
                    ? `Plugin "${pluginId}" has no MCP config writer; Studio-launched agents require an mcpConfig block for the app-owned gateway.`
                    : `Plugin "${pluginId}" does not declare an mcpConfig block; skipping MCP sync for this CLI.`,
            });
            continue;
        }
        if (plugin.manifest.capabilities.mcpServers !== true) {
            const hasRequired = clientServers.some((server) => server.required);
            issues.push({
                level: hasRequired ? 'error' : 'warning',
                client,
                message: hasRequired
                    ? `Plugin "${pluginId}" does not support managed MCP servers; Studio-launched agents require MCP support via capabilities.mcpServers.`
                    : `Plugin "${pluginId}" does not declare MCP server support; skipping MCP sync for this CLI.`,
            });
            continue;
        }
        const formatTargets = syncForFormat({
            client,
            plugin: plugin.manifest,
            workspaceRoot: input.workspaceRoot,
            servers: clientServers,
            knownServerIds: knownClientServerIds,
            pruneUnlisted: input.pruneUnlistedServers === true,
            write: input.write === true,
            context,
        });
        targets.push(...formatTargets.targets);
        issues.push(...formatTargets.issues);
    }
    const syncBlocking = issues.find((issue) => issue.level === 'error');
    if (syncBlocking) {
        return { ok: false, message: syncBlocking.message, issues };
    }
    return { ok: true, targets, issues };
}
function removeManagedSprintEngineConfig(input, context) {
    const clients = normalizeMcpClients(input.clients);
    const issues = [];
    if (!input.workspaceRoot || !existsSync(input.workspaceRoot)) {
        return { ok: false, message: 'Workspace root does not exist.', issues };
    }
    const targets = [];
    for (const client of clients) {
        const pluginId = pluginIdForCli(client);
        const plugin = context.lookupPlugin(pluginId);
        if (!plugin?.manifest.mcpConfig || plugin.manifest.capabilities.mcpServers !== true)
            continue;
        const formatTargets = syncForFormat({
            client,
            plugin: plugin.manifest,
            workspaceRoot: input.workspaceRoot,
            servers: [],
            knownServerIds: [MANAGED_SPRINTENGINE_MCP_SERVER_ID],
            pruneUnlisted: false,
            write: true,
            context,
        });
        targets.push(...formatTargets.targets);
        issues.push(...formatTargets.issues);
    }
    const blocking = issues.find((issue) => issue.level === 'error');
    if (blocking)
        return { ok: false, message: blocking.message, issues };
    return { ok: true, targets, issues };
}
function buildManagedSprintEngineServer(input) {
    const managed = input.managedSprintEngine;
    if (!managed?.statePath?.trim())
        return null;
    const clients = normalizeMcpClients(input.clients);
    if (managed.http?.url?.trim()) {
        return {
            id: MANAGED_SPRINTENGINE_MCP_SERVER_ID,
            name: 'Multicode Sprint Engine',
            description: 'Managed local Sprint Engine MCP server for autonomous Sprint Engine agent sessions.',
            transport: 'http',
            url: managed.http.url.trim(),
            envVarNames: managed.http.authTokenEnvVar?.trim() ? [managed.http.authTokenEnvVar.trim()] : [],
            headers: normalizeStringRecord(managed.http.headers),
            enabled: true,
            required: true,
            clients,
            scope: 'workspace',
            source: 'bundled',
            riskLevel: 'local-command',
            capabilities: ['sprintengine'],
        };
    }
    return missingManagedSprintEngineServer('Managed Sprint Engine HTTP MCP connection was not supplied; autonomous Sprint Engine agents require an app-owned HTTP MCP run.', clients);
}
function missingManagedSprintEngineServer(message, clients) {
    return {
        id: MANAGED_SPRINTENGINE_MCP_SERVER_ID,
        name: 'Multicode Sprint Engine',
        transport: 'stdio',
        command: `${MANAGED_MISSING_COMMAND_PREFIX}${message}`,
        args: [],
        enabled: true,
        required: true,
        clients,
        scope: 'workspace',
        source: 'bundled',
        riskLevel: 'local-command',
    };
}
export function findSprintEngineRuntimeRoot() {
    const candidates = [
        process.cwd(),
        maybeResourcesPath(),
        maybeAppPath(),
        join(__dirname, '..', '..'),
        join(__dirname, '..', '..', '..'),
    ].filter((candidate) => Boolean(candidate));
    return candidates.find((candidate) => existsSync(join(candidate, 'sprintengine_mcp', 'server.py'))
        && existsSync(join(candidate, 'sprintengine_core'))) ?? null;
}
function maybeResourcesPath() {
    const resourcesPath = process.resourcesPath;
    return resourcesPath || null;
}
function maybeAppPath() {
    try {
        const electron = loadElectron();
        return electron.app?.getAppPath?.() ?? null;
    }
    catch {
        return null;
    }
}
function defaultUserDataDir(homeDir) {
    try {
        const electron = loadElectron();
        const userData = electron.app?.getPath?.('userData');
        if (userData)
            return userData;
    }
    catch {
        // Node-only tests do not provide Electron's app object.
    }
    return join(homeDir(), '.multicode');
}
function normalizeSettings(settings, managedServer) {
    if (!settings || typeof settings !== 'object') {
        return {
            syncEnabled: Boolean(managedServer),
            servers: managedServer ? { [managedServer.id]: managedServer } : {},
        };
    }
    const servers = {};
    for (const value of Object.values(settings.servers ?? {})) {
        if (!value || typeof value !== 'object')
            continue;
        const normalized = normalizeServer(value);
        if (normalized)
            servers[normalized.id] = normalized;
    }
    if (managedServer) {
        servers[managedServer.id] = managedServer;
    }
    return {
        syncEnabled: settings.syncEnabled === true || Boolean(managedServer),
        servers,
    };
}
export function normalizeCatalogServer(value) {
    const server = normalizeServer({
        ...value,
        enabled: false,
        scope: (value?.recommendedScope ?? 'workspace'),
        source: 'bundled',
    });
    if (!server)
        return null;
    const candidate = value;
    return {
        ...server,
        defaultClients: normalizeMcpClients(candidate.defaultClients ?? server.clients),
        recommendedScope: candidate.recommendedScope === 'user' ? 'user' : 'workspace',
        setupNotes: typeof candidate.setupNotes === 'string' ? candidate.setupNotes : undefined,
    };
}
function validateServer(server) {
    const issues = [];
    if (server.transport === 'stdio') {
        const command = server.command?.trim();
        if (!command) {
            issues.push({ level: 'error', serverId: server.id, message: `${server.name} is missing a command.` });
        }
        else if (command.startsWith(MANAGED_MISSING_COMMAND_PREFIX)) {
            issues.push({
                level: 'error',
                serverId: server.id,
                message: command.slice(MANAGED_MISSING_COMMAND_PREFIX.length),
            });
        }
        else if (!commandExists(command)) {
            issues.push({ level: server.required ? 'error' : 'warning', serverId: server.id, message: `${server.name} command was not found: ${command}` });
        }
    }
    if ((server.transport === 'http' || server.transport === 'sse') && !server.url?.trim()) {
        issues.push({ level: 'error', serverId: server.id, message: `${server.name} is missing a URL.` });
    }
    if (server.id === MANAGED_SPRINTENGINE_MCP_SERVER_ID && server.transport === 'http' && !server.envVarNames?.[0]) {
        issues.push({
            level: 'error',
            serverId: server.id,
            message: `${server.name} requires an env-backed bearer token for managed Sprint Engine HTTP MCP launches.`,
        });
    }
    for (const envVar of server.envVarNames ?? []) {
        if (server.id === MANAGED_SPRINTENGINE_MCP_SERVER_ID && server.transport === 'http') {
            continue;
        }
        if (!process.env[envVar]) {
            issues.push({ level: server.required ? 'error' : 'warning', serverId: server.id, message: `${server.name} expects environment variable ${envVar}.` });
        }
    }
    return issues;
}
function commandExists(command) {
    if (isAbsolute(command))
        return existsSync(command);
    const pathValue = process.env.PATH ?? process.env.Path ?? '';
    const names = process.platform === 'win32'
        ? [command, `${command}.cmd`, `${command}.exe`, `${command}.ps1`]
        : [command];
    return pathValue.split(delimiter).some((dir) => names.some((name) => existsSync(join(dir, name))));
}
/**
 * The absolute path a plugin's declared MCP config template resolves to, or
 * null when the plugin declares none for that scope. The one place those
 * templates are substituted: the writers below and the read path
 * (src/main/mcp-config-readers/resolve-servers.ts) must agree byte for byte, or
 * the app would read a different file than it writes.
 */
export function resolveMcpConfigPath(spec, scope, workspaceRoot, homeDir) {
    const template = scope === 'user' ? spec.userPath : spec.path;
    if (!template)
        return null;
    const substituted = template
        .replace(/\{\{\s*workspaceRoot\s*\}\}/g, workspaceRoot)
        .replace(/\{\{\s*home\s*\}\}/g, homeDir())
        .replace(/^~(?=\/|$)/, homeDir());
    return substituted;
}
function syncForFormat(input) {
    const format = input.plugin.mcpConfig.format;
    switch (format) {
        case 'codex': {
            const result = syncCodex(input);
            return { targets: [result.target], issues: result.issues };
        }
        case 'claude-code': {
            const result = syncClaude(input);
            return { targets: [result.target], issues: result.issues };
        }
        case 'opencode': {
            const result = syncOpencode(input);
            return { targets: [result.target], issues: result.issues };
        }
        case 'generic': {
            const hasRequired = input.servers.some((server) => server.required);
            return {
                targets: [],
                issues: [
                    {
                        level: hasRequired ? 'error' : 'warning',
                        client: input.client,
                        message: hasRequired
                            ? `MCP sync writer for format "${format}" is not implemented yet; Studio-launched agents require a workspace stdio MCP config writer for plugin "${input.plugin.id}".`
                            : `MCP sync writer for format "${format}" is not implemented yet; declared in plugin "${input.plugin.id}".`,
                    },
                ],
            };
        }
    }
}
function syncCodex(input) {
    const { plugin, servers, knownServerIds, pruneUnlisted, workspaceRoot, write, context, client } = input;
    const scope = servers.some((server) => server.scope === 'user') ? 'user' : 'workspace';
    const resolved = resolveMcpConfigPath(plugin.mcpConfig, scope, workspaceRoot, context.homeDir);
    const serverIds = servers.map((server) => server.id);
    if (!resolved) {
        return { target: { client, path: '', serverIds }, issues: [] };
    }
    const target = { client, path: resolved, serverIds };
    if (write && (servers.length > 0 || knownServerIds.length > 0)) {
        const prepared = prepareWritableConfigFile(resolved, client);
        if (!prepared.ok)
            return { target, issues: [prepared.issue] };
        // Connector-scoped write: drop every [mcp_servers.*] table the repo committed
        // outside our managed block (renderCodexManagedBlock only rewrites the managed
        // block, which is the sole source of truth for the connector set). Keep none —
        // even a bare table sharing the connector id, to avoid a duplicate section.
        // Other codex config (model, profiles, …) is preserved.
        const base = pruneUnlisted
            ? removeCommittedCodexMcpServers(replaceManagedBlock(prepared.previous, ''))
            : prepared.previous;
        writeFileSync(resolved, servers.length ? replaceManagedBlock(base, renderCodexManagedBlock(servers)) : removeCodexManagedServers(base, knownServerIds), 'utf8');
    }
    return { target, issues: [] };
}
function syncClaude(input) {
    const { plugin, servers, knownServerIds, pruneUnlisted, workspaceRoot, write, context, client } = input;
    const workspaceServers = servers.filter((server) => server.scope === 'workspace');
    const userServers = servers.filter((server) => server.scope === 'user');
    const issues = userServers.map((server) => ({
        level: server.required ? 'error' : 'warning',
        client,
        serverId: server.id,
        message: `Claude user-scoped MCP sync is not implemented yet for ${server.name}; use workspace scope or claude mcp add.`,
    }));
    const path = resolveMcpConfigPath(plugin.mcpConfig, 'workspace', workspaceRoot, context.homeDir);
    if (!path) {
        return {
            target: { client, path: '', serverIds: workspaceServers.map((server) => server.id) },
            issues,
        };
    }
    if (write && (workspaceServers.length > 0 || knownServerIds.length > 0)) {
        const prepared = prepareWritableConfigFile(path, client);
        if (!prepared.ok) {
            return {
                target: { client, path, serverIds: workspaceServers.map((server) => server.id) },
                issues: [...issues, prepared.issue],
            };
        }
        let existing = {};
        if (prepared.existed) {
            try {
                existing = JSON.parse(prepared.previous);
            }
            catch {
                issues.push({
                    level: 'error',
                    client,
                    message: `.mcp.json is not valid JSON. Fix it before syncing Claude MCPs.`,
                });
                return {
                    target: { client, path, serverIds: workspaceServers.map((server) => server.id) },
                    issues,
                };
            }
        }
        const currentServers = existing.mcpServers && typeof existing.mcpServers === 'object'
            ? existing.mcpServers
            : {};
        // Connector-scoped write starts empty so any server the repo committed into
        // the worktree .mcp.json is dropped, not merged; the normal path preserves
        // the user's other servers and only replaces the ones we manage.
        const nextServers = pruneUnlisted ? {} : { ...currentServers };
        if (!pruneUnlisted) {
            for (const serverId of knownServerIds) {
                delete nextServers[serverId];
            }
        }
        for (const server of workspaceServers) {
            nextServers[server.id] = toClaudeServer(server);
        }
        writeFileSync(path, `${JSON.stringify({ ...existing, mcpServers: nextServers }, null, 2)}\n`, 'utf8');
        if (plugin.binary === 'claude' && workspaceServers.some((server) => server.id === STUDIO_MCP_SERVER_ID)) {
            const approvalIssue = enableStudioMcpForClaudeWorkspace(workspaceRoot, client, path, nextServers[STUDIO_MCP_SERVER_ID]);
            if (approvalIssue)
                issues.push(approvalIssue);
        }
    }
    return {
        target: { client, path, serverIds: workspaceServers.map((server) => server.id) },
        issues,
    };
}
// Claude records project MCP approval separately from `.mcp.json`. The Studio
// gateway is app-owned and required, so add only that one id to the allow-list;
// custom MCPs retain Claude's normal consent flow and every unrelated setting
// is preserved. Z.AI and Kimi Claude use the same Claude binary/config shape.
//
// Claude's approval is keyed by server ID only, so approval must never be
// granted against content we did not just write: a repo-committed `.mcp.json`
// squatting on our id would otherwise run an arbitrary command with no consent
// prompt. Verify the on-disk entry byte-matches the managed config at grant
// time; the sync path rewrites the entry on every launch, so drift is healed
// and re-verified per launch (installer command-shape rule, not id-trust).
function enableStudioMcpForClaudeWorkspace(workspaceRoot, client, mcpJsonPath, expectedServer) {
    try {
        const parsed = JSON.parse(readFileSync(mcpJsonPath, 'utf8'));
        const servers = (parsed.mcpServers ?? {});
        const onDisk = servers[STUDIO_MCP_SERVER_ID];
        if (JSON.stringify(onDisk) !== JSON.stringify(expectedServer)) {
            return {
                level: 'error',
                client,
                serverId: STUDIO_MCP_SERVER_ID,
                message: `${mcpJsonPath} does not contain the managed Studio MCP entry that was just written; refusing to pre-approve the server id.`,
            };
        }
    }
    catch (error) {
        return {
            level: 'error',
            client,
            serverId: STUDIO_MCP_SERVER_ID,
            message: `Could not verify ${mcpJsonPath} before approving the Studio MCP server: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
    const settingsPath = join(workspaceRoot, '.claude', 'settings.local.json');
    const prepared = prepareWritableConfigFile(settingsPath, client);
    if (!prepared.ok)
        return prepared.issue;
    let existing = {};
    if (prepared.existed && prepared.previous.trim()) {
        try {
            existing = JSON.parse(prepared.previous);
        }
        catch {
            return {
                level: 'error',
                client,
                message: `${settingsPath} is not valid JSON. Fix it before syncing the required Studio MCP server.`,
            };
        }
    }
    const strings = (value) => Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
    const withoutManagedIds = (values) => values.filter((id) => id !== STUDIO_MCP_SERVER_ID && id !== MANAGED_SPRINTENGINE_MCP_SERVER_ID);
    const enabled = [...withoutManagedIds(strings(existing.enabledMcpjsonServers)), STUDIO_MCP_SERVER_ID];
    const disabled = withoutManagedIds(strings(existing.disabledMcpjsonServers));
    const next = {
        ...existing,
        enabledMcpjsonServers: enabled,
    };
    if (disabled.length > 0)
        next.disabledMcpjsonServers = disabled;
    else
        delete next.disabledMcpjsonServers;
    writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return null;
}
function syncOpencode(input) {
    const { plugin, servers, knownServerIds, pruneUnlisted, workspaceRoot, write, context, client } = input;
    const issues = [];
    // OpenCode's `mcp` schema expresses local (stdio) and remote (HTTP) servers
    // only. Surface anything it cannot represent instead of writing a fake entry.
    const writableServers = [];
    for (const server of servers) {
        if (server.transport === 'sse') {
            issues.push({
                level: server.required ? 'error' : 'warning',
                client,
                serverId: server.id,
                message: `OpenCode MCP config supports local (stdio) and remote (HTTP) servers only; SSE server ${server.name} cannot be synced. Use an HTTP endpoint instead.`,
            });
            continue;
        }
        writableServers.push(server);
    }
    const serverIds = writableServers.map((server) => server.id);
    const scope = writableServers.some((server) => server.scope === 'user') ? 'user' : 'workspace';
    const path = resolveMcpConfigPath(plugin.mcpConfig, scope, workspaceRoot, context.homeDir);
    if (!path)
        return { target: { client, path: '', serverIds }, issues };
    if (issues.some((issue) => issue.level === 'error')) {
        return { target: { client, path, serverIds }, issues };
    }
    if (write && (writableServers.length > 0 || knownServerIds.length > 0)) {
        const prepared = prepareWritableConfigFile(path, client);
        if (!prepared.ok) {
            return { target: { client, path, serverIds }, issues: [...issues, prepared.issue] };
        }
        // Nothing to add and no file to prune from: do not create an empty config.
        if (!prepared.existed && writableServers.length === 0) {
            return { target: { client, path, serverIds }, issues };
        }
        let existing = {};
        if (prepared.existed && prepared.previous.trim()) {
            try {
                existing = JSON.parse(prepared.previous);
            }
            catch {
                issues.push({
                    level: 'error',
                    client,
                    message: `opencode.json is not valid JSON. Fix it before syncing OpenCode MCPs.`,
                });
                return { target: { client, path, serverIds }, issues };
            }
        }
        const currentServers = existing.mcp && typeof existing.mcp === 'object' && !Array.isArray(existing.mcp)
            ? existing.mcp
            : {};
        // Connector-scoped write drops any repo-committed server (start empty); the
        // normal path keeps the user's servers and only replaces the managed ones.
        const nextServers = pruneUnlisted ? {} : { ...currentServers };
        if (!pruneUnlisted) {
            for (const serverId of knownServerIds) {
                delete nextServers[serverId];
            }
        }
        for (const server of writableServers) {
            nextServers[server.id] = toOpencodeServer(server);
        }
        const next = { ...existing };
        if (Object.keys(nextServers).length) {
            next.mcp = nextServers;
        }
        else {
            delete next.mcp;
        }
        writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    }
    return { target: { client, path, serverIds }, issues };
}
function toOpencodeServer(server) {
    if (server.transport === 'stdio') {
        const entry = {
            type: 'local',
            command: opencodeLocalCommand(server),
        };
        if (server.env && Object.keys(server.env).length)
            entry.environment = server.env;
        return entry;
    }
    const entry = { type: 'remote', url: server.url ?? '' };
    const headers = opencodeRemoteHeaders(server);
    if (Object.keys(headers).length)
        entry.headers = headers;
    return entry;
}
function opencodeLocalCommand(server) {
    const command = server.command ?? '';
    const args = server.args ?? [];
    if (process.platform === 'win32' && command === 'npx') {
        return ['cmd', '/c', 'npx', ...args];
    }
    return [command, ...args];
}
function opencodeRemoteHeaders(server) {
    // OpenCode interpolates `{env:VAR}` in string fields; an env-backed bearer
    // token replaces any caller-supplied Authorization header so the literal
    // secret is never written to disk.
    const headers = server.envVarNames?.length
        ? Object.fromEntries(Object.entries(server.headers ?? {}).filter(([key]) => key.toLowerCase() !== 'authorization'))
        : { ...(server.headers ?? {}) };
    if (server.envVarNames?.[0]) {
        headers.Authorization = `Bearer {env:${server.envVarNames[0]}}`;
    }
    return headers;
}
function prepareWritableConfigFile(path, client) {
    const directory = dirname(path);
    try {
        if (existsSync(directory) && !statSync(directory).isDirectory()) {
            return {
                ok: false,
                issue: {
                    level: 'error',
                    client,
                    message: `Cannot sync MCP config for ${client}: expected ${directory} to be a directory, but it is a file. Rename or remove that file, or disable MCP sync for this CLI.`,
                },
            };
        }
        mkdirSync(directory, { recursive: true });
        if (!existsSync(path))
            return { ok: true, previous: '', existed: false };
        if (statSync(path).isDirectory()) {
            return {
                ok: false,
                issue: {
                    level: 'error',
                    client,
                    message: `Cannot sync MCP config for ${client}: expected ${path} to be a config file, but it is a directory. Rename or remove that directory, or disable MCP sync for this CLI.`,
                },
            };
        }
        return { ok: true, previous: readFileSync(path, 'utf8'), existed: true };
    }
    catch (error) {
        return {
            ok: false,
            issue: {
                level: 'error',
                client,
                message: `Cannot sync MCP config for ${client} at ${path}: ${error instanceof Error ? error.message : 'Unknown filesystem error.'}`,
            },
        };
    }
}
function replaceManagedBlock(previous, block) {
    const pattern = new RegExp(`${escapeRegExp(MANAGED_START)}[\\s\\S]*?${escapeRegExp(MANAGED_END)}\\n?`, 'm');
    const trimmed = previous.replace(pattern, '').trimEnd();
    if (!block)
        return trimmed ? `${trimmed}\n` : '';
    return `${trimmed}${trimmed ? '\n\n' : ''}${block}\n`;
}
function removeCodexManagedServers(previous, serverIds) {
    const ids = new Set(serverIds);
    if (ids.size === 0)
        return previous;
    const pattern = new RegExp(`${escapeRegExp(MANAGED_START)}[\\s\\S]*?${escapeRegExp(MANAGED_END)}\\n?`, 'm');
    const match = previous.match(pattern);
    if (!match)
        return previous;
    const block = match[0].replace(/\n?$/, '');
    const lines = block.split(/\r?\n/);
    const inner = lines.slice(1, -1);
    const preamble = [];
    const sections = [];
    let current = null;
    for (const line of inner) {
        const section = line.match(/^\[mcp_servers\.([a-z0-9_-]+)\]$/);
        if (section) {
            current = { id: section[1], lines: [line] };
            sections.push(current);
            continue;
        }
        if (current) {
            current.lines.push(line);
        }
        else {
            preamble.push(line);
        }
    }
    const remaining = sections.filter((section) => !ids.has(section.id));
    if (remaining.length === 0)
        return replaceManagedBlock(previous, '');
    while (preamble.length > 0 && preamble[preamble.length - 1] === '')
        preamble.pop();
    const nextBlock = [
        MANAGED_START,
        ...preamble,
        ...remaining.flatMap((section) => ['', ...section.lines]),
        MANAGED_END,
    ].join('\n');
    return replaceManagedBlock(previous, nextBlock);
}
// Strip every top-level `[mcp_servers.<id>]` table (and its sub-tables) from a
// codex config, leaving all other config intact. Used only on the connector-
// scoped write, after the managed block has been removed, so a server the base
// repo committed into the worktree config.toml cannot survive into a connector
// chat; the managed block re-added afterwards is the sole source of the connector.
function removeCommittedCodexMcpServers(text) {
    const out = [];
    let dropping = false;
    for (const line of text.split(/\r?\n/)) {
        const header = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/);
        if (header) {
            dropping = header[1].trim().replace(/^["']|["']$/g, '').split('.')[0] === 'mcp_servers';
        }
        if (!dropping)
            out.push(line);
    }
    return out.join('\n');
}
function renderCodexManagedBlock(servers) {
    return [
        MANAGED_START,
        '# This section is generated by Multicode Settings. Edit MCPs in Multicode or remove this block.',
        ...servers.flatMap(renderCodexServer),
        MANAGED_END,
    ].join('\n');
}
function renderCodexServer(server) {
    const lines = [`[mcp_servers.${server.id}]`];
    if (server.transport === 'stdio') {
        lines.push(`command = ${tomlString(server.command ?? '')}`);
        if (server.args?.length)
            lines.push(`args = [${server.args.map(tomlString).join(', ')}]`);
        if (server.envVarNames?.length)
            lines.push(`env_vars = [${server.envVarNames.map(tomlString).join(', ')}]`);
        if (server.env)
            lines.push(`env = { ${Object.entries(server.env).map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`).join(', ')} }`);
    }
    else {
        lines.push(`url = ${tomlString(server.url ?? '')}`);
        if (server.envVarNames?.length)
            lines.push(`bearer_token_env_var = ${tomlString(server.envVarNames[0])}`);
        const headers = server.envVarNames?.length
            ? Object.fromEntries(Object.entries(server.headers ?? {}).filter(([key]) => key.toLowerCase() !== 'authorization'))
            : server.headers;
        if (headers && Object.keys(headers).length)
            lines.push(`http_headers = { ${Object.entries(headers).map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`).join(', ')} }`);
    }
    lines.push(`enabled = ${server.enabled ? 'true' : 'false'}`);
    if (server.required && server.id !== MANAGED_SPRINTENGINE_MCP_SERVER_ID)
        lines.push('required = true');
    return ['', ...lines];
}
function toClaudeServer(server) {
    if (server.transport === 'stdio') {
        return {
            type: 'stdio',
            command: process.platform === 'win32' && server.command === 'npx' ? 'cmd' : server.command,
            args: process.platform === 'win32' && server.command === 'npx'
                ? ['/c', 'npx', ...(server.args ?? [])]
                : server.args ?? [],
            ...(server.env ? { env: server.env } : {}),
        };
    }
    return {
        type: server.transport === 'sse' ? 'sse' : 'http',
        url: server.url,
        ...httpHeadersForClaude(server),
    };
}
function httpHeadersForClaude(server) {
    const headers = { ...(server.headers ?? {}) };
    if (!headers.Authorization && server.envVarNames?.[0]) {
        headers.Authorization = `Bearer \${${server.envVarNames[0]}}`;
    }
    return Object.keys(headers).length ? { headers } : {};
}
function tomlString(value) {
    return JSON.stringify(value);
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
