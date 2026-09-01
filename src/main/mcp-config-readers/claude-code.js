// `claude-code` format: JSON with an `mcpServers` object keyed by server id.
// Five CLIs declare it — claude-code, grok, kimi-claude and zai all on
// `{{workspaceRoot}}/.mcp.json`, cursor on `{{workspaceRoot}}/.cursor/mcp.json`.
import { createFileMcpConfigReader } from './reader';
import { asRecord, stringArray, stringRecord, stringValue } from './values';
export function parseClaudeCodeMcpServers(raw) {
    const root = asRecord(JSON.parse(raw));
    if (!root)
        throw new Error('Expected a JSON object at the root of the MCP config.');
    const mcpServers = asRecord(root.mcpServers);
    if (!mcpServers)
        return [];
    const servers = [];
    for (const [id, value] of Object.entries(mcpServers)) {
        const config = asRecord(value);
        if (!config)
            continue;
        const type = typeof config.type === 'string' ? config.type.trim() : '';
        const url = stringValue(config.url);
        const command = stringValue(config.command);
        const transport = type === 'http' || type === 'sse'
            ? type
            : url ? 'http' : 'stdio';
        // An entry that names neither a command nor a URL is not a server the CLI
        // can reach, whatever else it declares.
        if (transport === 'stdio' && !command)
            continue;
        if (transport !== 'stdio' && !url)
            continue;
        servers.push({
            id,
            name: id,
            transport,
            command,
            args: stringArray(config.args),
            url,
            env: stringRecord(config.env),
            headers: stringRecord(config.headers),
            enabled: config.enabled === false ? false : true,
        });
    }
    return servers;
}
export const claudeCodeMcpReader = createFileMcpConfigReader('claude-code', parseClaudeCodeMcpServers);
