import type { AgentCli, CliRuntimeSettings } from '../../../types/workspace'

function labelForCliRuntime(cli: AgentCli): string {
  if (cli === 'codex') return 'Codex'
  if (cli === 'claude') return 'Claude'
  return cli
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ') || cli
}

export function buildCliRuntimeOptions(
  cliRuntimes: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>> | undefined,
): Array<{ value: AgentCli; label: string }> {
  const seen = new Set<AgentCli>()
  const orderedIds: AgentCli[] = []
  for (const id of ['codex', 'claude', ...Object.keys(cliRuntimes ?? {})]) {
    const trimmed = id.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    orderedIds.push(trimmed)
  }
  return orderedIds.map((value) => ({ value, label: labelForCliRuntime(value) }))
}
