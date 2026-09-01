import os from 'node:os';
import { readClaudeCodeUsage } from './claude-code-adapter';
import { readCodexUsage } from './codex-adapter';
import { readGrokUsage } from './grok-adapter';
import { readOpenCodeUsage } from './opencode-adapter';
// Which adapter family reads a given CLI runtime's session data. Z.AI runs the
// Claude Code binary against a redirected endpoint (manifest binary "claude"),
// so its transcripts live in the same ~/.claude layout and attribute to glm-*
// model ids via the transcript's own `message.model`. Any CLI not listed here
// falls back to the caller-supplied `isClaudeHarnessCli` manifest probe (the
// production wiring supplies one derived from the plugin registry, so future
// Anthropic-compatible claude-harness runtimes read their transcripts without
// touching this map), and only then to unmeasured — never a fabricated zero.
const ADAPTER_FAMILY_BY_CLI = {
    'claude-code': 'claude-code',
    zai: 'claude-code',
    codex: 'codex',
    opencode: 'opencode',
    grok: 'grok',
};
// Shared "meter reader" for Sprint Engine token accounting. Reads cumulative
// per-model token usage for one agent CLI session from that CLI's own on-disk
// data (or, for OpenCode, its local server). Pure reads — never mutates CLI
// state. Knows nothing about sprints, tasks, or aggregation; that join lives
// in report.ts.
//
// The contract is total honesty about coverage: a missing, unreadable, or
// unsupported source yields measured:false with an empty perModel and a
// sampledAt timestamp. It never throws and never fabricates a measured zero,
// so callers can show unmeasured agents truthfully instead of as 0 tokens.
// (The converse also holds: a readable source with no usage yet is a REAL
// zero — measured:true with empty rows — not unmeasured.)
export async function readSessionTokenUsage(cli, cliSessionId, deps = {}) {
    const sampledAt = (deps.now ?? defaultNow)();
    const unmeasured = {
        cli,
        cliSessionId,
        measured: false,
        perModel: [],
        sampledAt,
    };
    if (!cliSessionId)
        return unmeasured;
    const homeDir = deps.homeDir ?? os.homedir();
    const env = deps.env ?? process.env;
    const family = ADAPTER_FAMILY_BY_CLI[cli]
        ?? (deps.isClaudeHarnessCli?.(cli) ? 'claude-code' : undefined);
    try {
        let perModel;
        switch (family) {
            case 'claude-code':
                perModel = await readClaudeCodeUsage(cliSessionId, homeDir, env);
                break;
            case 'codex':
                perModel = await readCodexUsage(cliSessionId, homeDir, env);
                break;
            case 'opencode':
                perModel = await readOpenCodeUsage(cliSessionId, env, deps.fetchImpl ?? defaultFetch);
                break;
            case 'grok':
                perModel = await readGrokUsage(cliSessionId, homeDir, env);
                break;
            default:
                return unmeasured;
        }
        if (!perModel)
            return unmeasured;
        return { cli, cliSessionId, measured: true, perModel, sampledAt };
    }
    catch {
        // Contract: any unexpected read failure degrades to unmeasured, never a throw.
        return unmeasured;
    }
}
function defaultNow() {
    return new Date().toISOString();
}
const defaultFetch = (url, init) => globalThis.fetch(url, init);
