import { claudeCodeMcpReader } from './claude-code';
import { codexMcpReader } from './codex';
import { opencodeMcpReader } from './opencode';
/**
 * Every MCP config format with a reader, keyed by the value plugins declare in
 * `mcpConfig.format`. Adding a format is this line plus its adapter file: the
 * resolver looks the format up here and never learns a format name itself.
 *
 * `generic` has no reader on purpose. It is the declared escape hatch for a CLI
 * whose config shape nobody has written an adapter for, and the resolver states
 * that as a diagnostic rather than reporting the CLI as having no servers.
 */
export const MCP_CONFIG_READERS = new Map([
    [claudeCodeMcpReader.format, claudeCodeMcpReader],
    [codexMcpReader.format, codexMcpReader],
    [opencodeMcpReader.format, opencodeMcpReader],
]);
