import { homedir } from 'os';
import { resolveMcpConfigPath } from '../mcp-config-service';
import { MCP_CONFIG_READERS } from './registry';
export function createMcpServerResolver(options = {}) {
    const readers = options.readers ?? MCP_CONFIG_READERS;
    const homeDir = options.homeDir ?? (() => homedir());
    return {
        async resolve({ workspaceRoot, targets }) {
            // Config files are shared: claude-code, grok, kimi-claude and zai all
            // declare the same `{{workspaceRoot}}/.mcp.json`. Reads are keyed by
            // format and resolved path, so that file is opened once however many CLIs
            // are asked about, and each of them is attributed the result.
            const reads = new Map();
            const readOnce = (reader, path) => {
                const key = `${reader.format}\u0000${path}`;
                const started = reads.get(key);
                if (started)
                    return started;
                const read = reader.read(path);
                reads.set(key, read);
                return read;
            };
            const resolved = await Promise.all(targets.map(async (target) => [
                target.pluginId,
                await resolveTarget(target, { workspaceRoot, readers, homeDir, readOnce }),
            ]));
            return new Map(resolved);
        },
    };
}
async function resolveTarget(target, context) {
    const reader = context.readers.get(target.spec.format);
    if (!reader) {
        // A format nobody has written an adapter for is stated, never rendered as
        // "this CLI has no servers" — the config file is right there, unread.
        const path = resolveMcpConfigPath(target.spec, 'workspace', context.workspaceRoot, context.homeDir);
        return {
            servers: [],
            diagnostics: [{
                    capability: 'servers',
                    reason: 'unreadable',
                    path: path ?? '',
                    message: `No MCP config reader for format "${target.spec.format}", declared by plugin "${target.pluginId}".`,
                }],
        };
    }
    const diagnostics = [];
    const byId = new Map();
    // User scope first so workspace overwrites it by server id. Verified against
    // the CLIs themselves rather than assumed: both that declare a `userPath`
    // resolve a project entry over the user entry of the same id, and union the
    // ids either scope declares alone (`codex mcp list --json` with `CODEX_HOME`
    // pointed at a fixture home; `opencode mcp list` with `XDG_CONFIG_HOME`).
    for (const scope of ['user', 'workspace']) {
        const path = resolveMcpConfigPath(target.spec, scope, context.workspaceRoot, context.homeDir);
        if (!path)
            continue;
        const read = await context.readOnce(reader, path);
        if (!read.ok) {
            // A config file the CLI never created is normal and says nothing; the
            // other two reasons are faults the surface must be able to name.
            if (read.reason !== 'missing') {
                diagnostics.push({ capability: 'servers', reason: read.reason, path, message: read.message });
            }
            continue;
        }
        for (const server of read.servers) {
            // No `toolCount`: it is not in any config file, and the surface renders
            // nothing rather than a number nobody read (plan decision D5).
            byId.set(server.id, {
                id: server.id,
                transport: server.transport,
                scope,
                configPath: path,
            });
        }
    }
    return {
        servers: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
        diagnostics,
    };
}
