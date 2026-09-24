import { join } from 'node:path'

/**
 * Where the Claude family keeps its state. `CLAUDE_CONFIG_DIR` wins, taking the
 * first entry of a comma-separated list, exactly as the token-usage adapter
 * resolves it — the settings writer and the skills scan must not disagree with
 * the CLI about which directory is its own.
 */
export function resolveClaudeConfigDir(homeDir: string, env: NodeJS.ProcessEnv): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim()
  if (override) {
    const first = override.split(',')[0]?.trim()
    if (first) return first
  }
  return join(homeDir, '.claude')
}
