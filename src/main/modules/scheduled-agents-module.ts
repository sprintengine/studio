import { BrowserWindow, app } from 'electron'

import { createGitWorktree, getGitRepoRoot } from '../git'
import { withGitHost } from '../git-run'
import { hostRegistry } from '../hosts/host-registry'
import { powerActivity } from '../power-activity'
import {
  ConversationLaunchServiceToken,
  ScheduledAgentsModuleServiceToken,
  ScheduledAgentsServiceToken,
} from '../module-host/service-tokens'
import type { CapabilityModule } from '../module-host/load-modules'
import { runScheduledAgent } from '../scheduled-agents/runner'
import { createScheduledAgentsScheduler } from '../scheduled-agents/scheduler'
import {
  createScheduledAgentsModuleRegistry,
  createScheduledAgentsService,
  type ScheduledAgentsService,
} from '../scheduled-agents/service'
import { createScheduledAgentsStore, scheduledAgentsFilePath } from '../scheduled-agents/store'
import { isWslHostId, type ExecutionHostId } from '../../shared/execution-host'
import {
  SCHEDULED_AGENTS_CHANGED_CHANNEL,
  SCHEDULED_AGENTS_IPC,
  type ScheduledAgentView,
} from '../../shared/scheduled-agents'
import { isRecord } from '../../shared/records'

// The machine whose git answers for a folder: a WSL distribution's own git for
// a folder in it, so the run's worktree names a gitdir that machine can follow.
function gitHostFor(hostId: ExecutionHostId | null) {
  return hostId && isWslHostId(hostId) ? hostRegistry().get(hostId) : null
}

function broadcastScheduledAgents(agents: ScheduledAgentView[]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    try {
      window.webContents.send(SCHEDULED_AGENTS_CHANGED_CHANNEL, agents)
    } catch {
      // Best-effort per window.
    }
  }
}

export function createScheduledAgentsModule(): CapabilityModule {
  return {
    manifest: {
      id: 'scheduled-agents',
      displayName: 'Scheduled agents',
      version: 1,
      publisher: 'sprintengine',
      category: 'orchestration',
      summary: 'Start a chat agent with a prompt on a schedule.',
      defaultEnabled: true,
      dependsOn: ['agent-runtime'],
    },
    registerMain(host) {
      const conversationLaunchService = host.requireService(ConversationLaunchServiceToken)
      const store = createScheduledAgentsStore({
        filePath: scheduledAgentsFilePath(app.getPath('userData')),
        warn: (message) => console.warn(`[scheduled-agents] ${message}`),
      })
      // Late-bound: the scheduler reports a finished run to the service, which
      // is built around the scheduler.
      let service: ScheduledAgentsService | null = null
      const scheduler = createScheduledAgentsScheduler({
        list: () => store.list(),
        recordRun: (id, run) => store.recordRun(id, run),
        onRan: () => service?.notifyChanged(),
        run: (agent) =>
          runScheduledAgent(agent, {
            launchConversation: (request) => conversationLaunchService.launch(request),
            getRepoRoot: (folderPath, hostId) => withGitHost(gitHostFor(hostId), () => getGitRepoRoot(folderPath)),
            createWorktree: async (input) => {
              const created = await withGitHost(gitHostFor(input.hostId), () =>
                createGitWorktree({
                  repoRoot: input.repoRoot,
                  containerPath: input.containerPath,
                  destinationPath: input.destinationPath,
                  branchName: input.branchName,
                  baseRef: 'HEAD',
                  copyIncludedFiles: true,
                  // The chat is created after its worktree, so the branch names the owner.
                  agentLockOwner: input.branchName,
                }),
              )
              return created.ok
                ? { ok: true, path: created.data.path, branch: created.data.branch ?? input.branchName }
                : { ok: false, message: created.message }
            },
          }),
      })
      const scheduledAgents = createScheduledAgentsService({ store, scheduler })
      service = scheduledAgents
      host.provideService(ScheduledAgentsServiceToken, () => scheduledAgents)
      host.provideService(ScheduledAgentsModuleServiceToken, () => createScheduledAgentsModuleRegistry(scheduledAgents))
      const unsubscribe = scheduledAgents.onChanged(broadcastScheduledAgents)
      host.onShutdown(unsubscribe)

      const idOf = (input: unknown): string => (isRecord(input) && typeof input.id === 'string' ? input.id : '')
      host.registerIpc(SCHEDULED_AGENTS_IPC.list, async () => scheduledAgents.list())
      host.registerIpc(SCHEDULED_AGENTS_IPC.create, async (_event, input: unknown) =>
        scheduledAgents.create(isRecord(input) ? input.draft : undefined),
      )
      host.registerIpc(SCHEDULED_AGENTS_IPC.update, async (_event, input: unknown) =>
        scheduledAgents.update(idOf(input), isRecord(input) ? input.draft : undefined),
      )
      host.registerIpc(SCHEDULED_AGENTS_IPC.remove, async (_event, input: unknown) =>
        scheduledAgents.remove(idOf(input)),
      )
      host.registerIpc(SCHEDULED_AGENTS_IPC.runNow, async (_event, input: unknown) =>
        scheduledAgents.runNow(idOf(input)),
      )
      host.registerIpc(SCHEDULED_AGENTS_IPC.markSeen, async (_event, input: unknown) => {
        await scheduledAgents.markFailureSeen(idOf(input))
        return { ok: true }
      })

      let releaseWakeOnResume: (() => void) | null = null
      host.registerSidecar(
        {
          id: 'scheduled-agents-scheduler',
          kind: 'scheduler',
          description: 'Starts each scheduled agent’s chat when its schedule comes round.',
          startOn: 'startup',
        },
        {
          start: async () => {
            await store.load()
            scheduler.start()
            scheduledAgents.notifyChanged()
            // A timer armed before a sleep counts only awake time, so a run
            // that came due during the nap is found on waking.
            releaseWakeOnResume?.()
            releaseWakeOnResume = powerActivity.onResume(() => scheduledAgents.notifyChanged())
          },
          stop: async () => {
            releaseWakeOnResume?.()
            releaseWakeOnResume = null
            scheduler.stop()
          },
          status: () => ({ state: scheduler.isRunning() ? 'running' : 'stopped' }),
        },
      )
    },
  }
}
