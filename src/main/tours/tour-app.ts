import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import type { AgentLaunchRequest } from '../../shared/agent-launch'
import { changelistOwnerId, pathsOfChangelist } from '../../shared/git/changelists'
import type { TerminalSessionSnapshot } from '../../shared/ipc/terminal'
import { getGitChangelists } from '../git-changelists'
import { listTourFiles, readTourFile, resolveCommit, resolveHead, resolveRepoRoot } from './tour-git'
import { createTourService, type TourService } from './tour-service'
import { createTourStore } from './tour-store'

// The tour service as the running app builds it: the real git, the app-data
// store, the terminal runtime and the windows. Kept out of app-services so the
// service itself stays constructible headless (tour-service.test.ts).

export type AppTourServiceOptions = {
  userDataDir: string
  resolveWorkspaceRoot(workspaceId: string): string | null
  listTerminals(): TerminalSessionSnapshot[]
  writeTerminal(sessionId: string, data: string): void
  launchAgent(request: AgentLaunchRequest): Promise<{ ok: true; agentId: string } | { ok: false; message: string }>
  broadcastToWorkspaceWindows(channel: string, payload: unknown): void
  broadcastToViewers(channel: string, payload: unknown): void
  isAppFocused(): boolean
}

export function createAppTourService(options: AppTourServiceOptions): {
  service: TourService
  setAttention(notify: (key: string) => void): void
} {
  let notify: ((key: string) => void) | null = null
  const service = createTourService({
    store: createTourStore(join(options.userDataDir, 'tours')),
    git: { resolveRepoRoot, resolveCommit, resolveHead, listTourFiles, readTourFile },
    now: () => Date.now(),
    newId: () => randomUUID(),
    resolveWorkspaceRoot: options.resolveWorkspaceRoot,
    resolveAgentCheckout: (agentId) => {
      const session = options
        .listTerminals()
        .find((candidate) => candidate.kind === 'agent' && candidate.agentId === agentId && candidate.processAlive)
      if (!session) return null
      // Where the agent's hooks last saw it wins over where it was launched: an
      // agent that moved into a worktree wrote its changes there.
      return session.observedCheckout?.gitRoot || session.worktreePath || session.cwd || null
    },
    readChangelistPaths: async (repoRoot, agentId) => {
      try {
        const lists = await getGitChangelists(options.userDataDir, repoRoot)
        const own = lists.find((list) => list.id === changelistOwnerId(agentId))
        return own ? pathsOfChangelist(own) : null
      } catch {
        return null
      }
    },
    broadcastToWorkspaceWindows: options.broadcastToWorkspaceWindows,
    broadcastToViewers: options.broadcastToViewers,
    isAppFocused: options.isAppFocused,
    requestAttention: (key) => notify?.(key),
    listTerminals: options.listTerminals,
    writeTerminal: options.writeTerminal,
    launchAgent: options.launchAgent,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  })
  return {
    service,
    setAttention: (next) => {
      notify = next
    },
  }
}
