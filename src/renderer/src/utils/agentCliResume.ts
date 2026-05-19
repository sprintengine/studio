import type { AgentCli } from '../types/workspace'

export function agentCliSupportsConversationResume(cli: AgentCli | undefined): boolean {
  return cli === 'codex' || cli === 'claude'
}

export function agentCliUsesStableSessionIdForResume(cli: AgentCli | undefined): boolean {
  return cli === 'claude'
}
