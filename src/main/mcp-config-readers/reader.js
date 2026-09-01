// Reading which MCP servers a CLI is actually configured with.
//
// The write path (src/main/mcp-config-service.ts) is already manifest-driven:
// each plugin declares `mcpConfig.path`, `mcpConfig.userPath` and
// `mcpConfig.format`, and the writer renders the right shape into the right
// file. This is the same map read backwards — one adapter per declared format,
// looked up by key in src/main/mcp-config-readers/registry.ts. A thirteenth CLI
// on a new format is a new adapter file and a registry line, never another case
// in a switch, and no config path is ever written as a literal outside a
// plugin manifest.
import { readFile } from 'fs/promises';
/**
 * The filesystem half every adapter shares: read the bytes, map the errno to a
 * reason, and let the format's own parser throw for anything it cannot make
 * sense of. Adapters stay pure string → servers functions, which is also what
 * makes them testable against a fixture without touching disk.
 */
export function createFileMcpConfigReader(format, parse) {
    return {
        format,
        async read(absolutePath) {
            let raw;
            try {
                raw = await readFile(absolutePath, 'utf8');
            }
            catch (error) {
                if (error.code === 'ENOENT') {
                    return { ok: false, reason: 'missing', message: 'No MCP config file here.' };
                }
                return { ok: false, reason: 'unreadable', message: errorMessage(error) };
            }
            try {
                return { ok: true, servers: parse(raw) };
            }
            catch (error) {
                return { ok: false, reason: 'malformed', message: errorMessage(error) };
            }
        },
    };
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
