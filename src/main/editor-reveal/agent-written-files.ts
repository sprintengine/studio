// The files each agent session reported writing, for the editor reveal's second
// tier: a file outside the workspace that THIS agent wrote (the patch it left in
// /tmp for the person to copy to a VM) may be shown without asking.
//
// Fed from the same edit hooks as the agent's changelist (`onAgentFileEdit`),
// and kept apart from the session's own `fileChanges` ledger because that one
// is bounded for display and starts over when the pty respawns; a file the
// agent wrote an hour ago is still one it wrote. Still bounded — per agent and
// in agents — because it lives for the whole app session.

const MAX_PATHS_PER_AGENT = 1_000
const MAX_AGENTS = 128

export type AgentWrittenFiles = {
  note(agentId: string | undefined, path: string): void
  pathsOf(agentId: string): Iterable<string>
}

export function createAgentWrittenFiles(): AgentWrittenFiles {
  const byAgent = new Map<string, Set<string>>()
  return {
    note(agentId, path) {
      const id = agentId?.trim()
      if (!id || !path) return
      let paths = byAgent.get(id)
      if (paths) {
        // Most recently written last, so the oldest is what a full set drops.
        byAgent.delete(id)
        paths.delete(path)
      } else {
        paths = new Set()
      }
      byAgent.set(id, paths)
      paths.add(path)
      if (paths.size > MAX_PATHS_PER_AGENT) {
        const oldest = paths.values().next().value
        if (oldest !== undefined) paths.delete(oldest)
      }
      if (byAgent.size > MAX_AGENTS) {
        const stalest = byAgent.keys().next().value
        if (stalest !== undefined) byAgent.delete(stalest)
      }
    },
    pathsOf(agentId) {
      return byAgent.get(agentId) ?? []
    },
  }
}
