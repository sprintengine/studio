import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, relative } from 'path';
import { normalizeMcpClients, normalizeMcpServerConfig, } from './mcp-config-service';
// One parser per config format, shared with the agent-capability read path
// (src/main/mcp-config-readers). Two parsers for one file format would disagree
// eventually, and the surface that lists a CLI's servers must see exactly what
// this wizard offers to import.
import { parseClaudeCodeMcpServers } from './mcp-config-readers/claude-code';
import { parseCodexMcpServers } from './mcp-config-readers/codex';
export function createAgentConfigImportService(options) {
    return {
        detect: async (input) => {
            const discovery = await discoverExistingAgentConfig(input, options);
            return {
                ok: true,
                mcpServers: discovery.mcpServers.map((server) => server.entry),
                skills: discovery.skills.map((skill) => skill.entry),
                warnings: discovery.warnings,
            };
        },
        adopt: (input) => adoptAgentConfig(input, options),
    };
}
async function adoptAgentConfig(input, options) {
    const workspaceRoot = typeof input?.workspaceRoot === 'string' ? input.workspaceRoot.trim() : '';
    if (!workspaceRoot || !isDirectory(workspaceRoot)) {
        return { ok: false, message: 'Workspace root does not exist.' };
    }
    const discovery = await discoverExistingAgentConfig(undefined, options);
    const warnings = [...discovery.warnings];
    const mcpByKey = new Map(discovery.mcpServers.map((server) => [server.entry.key, server]));
    const skillByKey = new Map(discovery.skills.map((skill) => [skill.entry.key, skill]));
    const selectedMcpKeys = normalizeStringSet(input?.mcpServerKeys);
    const selectedSkillKeys = normalizeStringSet(input?.skillKeys);
    for (const key of selectedMcpKeys) {
        if (!mcpByKey.has(key)) {
            return { ok: false, message: `Selected MCP server was not found: ${key}`, warnings };
        }
    }
    for (const key of selectedSkillKeys) {
        const skill = skillByKey.get(key);
        if (!skill)
            return { ok: false, message: `Selected skill was not found: ${key}`, warnings };
        if (!skill.entry.adoptable) {
            return {
                ok: false,
                message: `Cannot adopt custom skill "${skill.skillId}" through the built-in skill sync path.`,
                warnings,
            };
        }
    }
    const adoptedMcpServers = [];
    const selectedMcpServers = Array.from(selectedMcpKeys, (key) => mcpByKey.get(key));
    if (selectedMcpServers.length > 0) {
        const settings = buildAdoptedMcpSettings(selectedMcpServers, warnings);
        const clients = normalizeMcpClients(Object.values(settings.servers).flatMap((server) => server.clients));
        const syncResult = options.mcpConfigService.sync({ workspaceRoot, settings, clients });
        if (!syncResult.ok) {
            return {
                ok: false,
                message: syncResult.message,
                adoptedMcpServers,
                adoptedSkills: [],
                warnings: [...warnings, ...(syncResult.issues ?? []).map((issue) => issue.message)],
            };
        }
        warnings.push(...syncResult.issues.filter((issue) => issue.level === 'warning').map((issue) => issue.message));
        for (const server of Object.values(settings.servers)) {
            adoptedMcpServers.push({ id: server.id, clients: server.clients });
        }
    }
    const adoptedSkills = [];
    const selectedSkillIds = Array.from(new Set(Array.from(selectedSkillKeys, (key) => skillByKey.get(key).skillId)));
    for (const skillId of selectedSkillIds) {
        const result = await options.builtinSkillManager.install(workspaceRoot, skillId);
        if (!result.ok) {
            return {
                ok: false,
                message: result.message,
                adoptedMcpServers,
                adoptedSkills,
                warnings,
            };
        }
        adoptedSkills.push({ id: result.skill.id, status: result.status });
    }
    return { ok: true, adoptedMcpServers, adoptedSkills, warnings };
}
function buildAdoptedMcpSettings(servers, warnings) {
    const byId = new Map();
    for (const discovered of servers) {
        const existing = byId.get(discovered.server.id);
        if (!existing) {
            byId.set(discovered.server.id, { ...discovered.server, clients: [...discovered.server.clients] });
            continue;
        }
        existing.clients = normalizeMcpClients([...existing.clients, ...discovered.server.clients]);
        if (!sameMcpServerTarget(existing, discovered.server)) {
            warnings.push(`Duplicate MCP server "${existing.id}" was found in multiple agent configs; using the first config and merging clients.`);
        }
    }
    return {
        syncEnabled: true,
        servers: Object.fromEntries(Array.from(byId.values()).map((server) => [server.id, server])),
    };
}
function sameMcpServerTarget(a, b) {
    return a.transport === b.transport
        && (a.command ?? '') === (b.command ?? '')
        && (a.url ?? '') === (b.url ?? '')
        && JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? []);
}
async function discoverExistingAgentConfig(input, options) {
    const home = options.homeDir?.() ?? homedir();
    const selectedSources = new Set(normalizeSources(input?.sources));
    const builtInSkills = await options.builtinSkillManager.list();
    const builtInSkillById = new Map(builtInSkills.map((skill) => [skill.id, skill]));
    const warnings = [];
    const mcpServers = [];
    const skills = [];
    for (const source of sourceConfigs(home)) {
        if (!selectedSources.has(source.source))
            continue;
        for (const configPath of source.mcpConfigPaths) {
            mcpServers.push(...readMcpConfigPath(source, configPath, home, warnings));
        }
        skills.push(...readSkillDirectory(source, home, builtInSkillById, warnings));
    }
    return { mcpServers: dedupeMcpServers(mcpServers, warnings), skills, warnings };
}
/**
 * STATUS, settled by the spec review of the capability read path: this wizard is
 * *partly* migrated, deliberately. Its format parsing moved onto the shared
 * adapters (the imports above), so it and the capability query can never
 * disagree about what a config file says. Its *sources* are still this literal
 * pair, because it answers a different question: what an existing user-scope
 * install of Codex or Claude Code holds that Multicode could adopt on first run.
 * `AgentConfigImportSource` is the two-value union the onboarding surface
 * renders, so widening this list is a product change, not a refactor.
 *
 * It is not the map for "what can this agent reach" — `agentCapabilities`
 * (src/main/workspace-skills-service.ts) is, and it is manifest-driven end to
 * end. Nothing here is read by that path.
 *
 * Migrating the remainder is blocked on the manifests, not on this file. Only
 * `codex` and `opencode` declare an `mcpConfig.userPath`; the five claude-format
 * CLIs declare none, so there is nothing for `resolveMcpConfigPath(spec, 'user',
 * …)` to resolve. The three candidate paths below are what Claude Code actually
 * uses, and which of them is authoritative has not been established — that is
 * the decision to settle before this list is derived rather than written.
 */
function sourceConfigs(home) {
    return [
        {
            source: 'codex',
            client: 'codex',
            mcpConfigPaths: [join(home, '.codex', 'config.toml')],
            skillsDir: join(home, '.codex', 'skills'),
        },
        {
            source: 'claude-code',
            client: 'claude-code',
            mcpConfigPaths: [
                join(home, '.claude', '.mcp.json'),
                join(home, '.claude', 'mcp.json'),
                join(home, '.claude.json'),
            ],
            skillsDir: join(home, '.claude', 'skills'),
        },
    ];
}
function normalizeSources(value) {
    const sources = (value ?? ['codex', 'claude-code']).filter((source) => source === 'codex' || source === 'claude-code');
    return Array.from(new Set(sources));
}
function dedupeMcpServers(servers, warnings) {
    const byKey = new Map();
    for (const server of servers) {
        if (byKey.has(server.entry.key)) {
            warnings.push(`Duplicate MCP server "${server.entry.id}" was found in ${server.entry.source}; using the first detected config.`);
            continue;
        }
        byKey.set(server.entry.key, server);
    }
    return Array.from(byKey.values());
}
function readMcpConfigPath(source, configPath, home, warnings) {
    if (!existsSync(configPath))
        return [];
    const sourceLabel = homeRelativeLabel(home, configPath);
    if (!isFile(configPath)) {
        warnings.push(`${sourceLabel} exists but is not a file; skipping MCP import from it.`);
        return [];
    }
    try {
        const raw = readFileSync(configPath, 'utf8');
        const servers = source.source === 'codex'
            ? parseCodexMcpServers(raw)
            : parseClaudeCodeMcpServers(raw);
        return servers
            .map((server) => normalizeDetectedServer(source, sourceLabel, server))
            .filter((server) => Boolean(server));
    }
    catch (error) {
        warnings.push(`${sourceLabel} could not be read as ${source.source} MCP config: ${errorMessage(error)}`);
        return [];
    }
}
function normalizeDetectedServer(source, sourceLabel, raw) {
    const server = normalizeMcpServerConfig({
        id: raw.id,
        name: raw.name ?? raw.id,
        transport: raw.transport,
        command: raw.command,
        args: raw.args,
        url: raw.url,
        env: raw.env,
        envVarNames: raw.envVarNames,
        headers: raw.headers,
        enabled: raw.enabled !== false,
        clients: [source.client],
        scope: 'workspace',
        source: 'custom',
        riskLevel: riskLevelForRawServer(raw),
    });
    if (!server)
        return null;
    return {
        server,
        entry: {
            key: mcpServerKey(source.source, server.id),
            id: server.id,
            name: server.name,
            source: source.source,
            sourceLabel,
            transport: server.transport,
            enabled: server.enabled,
            envVarNames: server.envVarNames ?? [],
            hasSecretValues: hasStringRecord(server.env) || hasStringRecord(server.headers),
        },
    };
}
function readSkillDirectory(source, home, builtInSkillById, warnings) {
    if (!existsSync(source.skillsDir))
        return [];
    const sourceLabel = homeRelativeLabel(home, source.skillsDir);
    if (!isDirectory(source.skillsDir)) {
        warnings.push(`${sourceLabel} exists but is not a directory; skipping skill import from it.`);
        return [];
    }
    try {
        return readdirSync(source.skillsDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort((a, b) => a.localeCompare(b))
            .map((skillId) => {
            const builtInSkill = builtInSkillById.get(skillId);
            return {
                skillId,
                entry: {
                    key: skillKey(source.source, skillId),
                    id: skillId,
                    name: builtInSkill?.name ?? skillId,
                    source: source.source,
                    sourceLabel: `${sourceLabel}/${skillId}`,
                    adoptable: Boolean(builtInSkill),
                },
            };
        });
    }
    catch (error) {
        warnings.push(`${sourceLabel} could not be listed: ${errorMessage(error)}`);
        return [];
    }
}
function riskLevelForRawServer(server) {
    if (hasStringRecord(server.env) || hasStringRecord(server.headers) || (server.envVarNames?.length ?? 0) > 0) {
        return 'secrets';
    }
    if (server.transport === 'http' || server.transport === 'sse')
        return 'network';
    if (server.command)
        return 'local-command';
    return 'low';
}
function hasStringRecord(value) {
    return Boolean(value && Object.keys(value).length > 0);
}
function normalizeStringSet(value) {
    return new Set((value ?? []).filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()));
}
function mcpServerKey(source, id) {
    return `mcp:${source}:${id}`;
}
function skillKey(source, id) {
    return `skill:${source}:${id}`;
}
function isFile(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
function isDirectory(path) {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
function homeRelativeLabel(home, path) {
    const rel = relative(home, path).replace(/\\/g, '/');
    return rel && !rel.startsWith('..') ? `~/${rel}` : path;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : 'Unknown error.';
}
