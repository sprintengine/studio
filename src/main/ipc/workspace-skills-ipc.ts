import type { IpcMain, WebContents } from 'electron'
import type {
  AgentCapabilitiesWatchInput,
  WorkspaceSkillsListInput,
  WorkspaceSkillsListResult,
} from '../../shared/electron-api'
import type { AgentCapabilitiesInput, AgentCapabilitiesResult } from '../../shared/skills'
import type { CapabilityWatcher } from '../capability-watcher'
import type { AgentCapabilityService, WorkspaceSkillsService } from '../workspace-skills-service'

export const AGENT_CAPABILITIES_INVALIDATED_CHANNEL = 'skills:agent-capabilities-invalidated'

export function registerWorkspaceSkillsIpc(
  ipcMain: IpcMain,
  services: {
    workspaceSkills: WorkspaceSkillsService
    agentCapabilities: AgentCapabilityService
    capabilityWatcher: CapabilityWatcher
  },
): void {
  ipcMain.handle(
    'skills:list-workspace',
    (_, input: WorkspaceSkillsListInput): Promise<WorkspaceSkillsListResult> =>
      services.workspaceSkills.listWorkspaceSkills(input),
  )
  ipcMain.handle(
    'skills:agent-capabilities',
    (_, input: AgentCapabilitiesInput): Promise<AgentCapabilitiesResult> =>
      services.agentCapabilities.resolve(input),
  )

  // One subscription per (sender, workspace), refcounted in the watcher: the
  // first start attaches the watchers and the last stop tears them down. A
  // window that closes without stopping is released on `destroyed`; a window
  // that *reloads* keeps its sender id, and the re-subscribe is deduplicated by
  // that key, so it reuses the subscription instead of stacking a second one.
  const subscriptions = new Map<string, () => void>()
  const trackedSenders = new Set<number>()
  const key = (sender: WebContents, workspaceRoot: string): string => `${sender.id}::${workspaceRoot}`

  ipcMain.handle('skills:agent-capabilities-watch-start', (event, input: AgentCapabilitiesWatchInput): void => {
    const workspaceRoot = input.workspaceRoot?.trim()
    if (!workspaceRoot || subscriptions.has(key(event.sender, workspaceRoot))) return
    const sender = event.sender
    const release = services.capabilityWatcher.subscribe(workspaceRoot, (invalidation) => {
      if (sender.isDestroyed()) return
      sender.send(AGENT_CAPABILITIES_INVALIDATED_CHANNEL, invalidation)
    })
    subscriptions.set(key(sender, workspaceRoot), release)
    if (trackedSenders.has(sender.id)) return
    trackedSenders.add(sender.id)
    sender.once('destroyed', () => {
      trackedSenders.delete(sender.id)
      for (const [subscriptionKey, dispose] of subscriptions) {
        if (!subscriptionKey.startsWith(`${sender.id}::`)) continue
        dispose()
        subscriptions.delete(subscriptionKey)
      }
    })
  })

  ipcMain.handle('skills:agent-capabilities-watch-stop', (event, input: AgentCapabilitiesWatchInput): void => {
    const workspaceRoot = input.workspaceRoot?.trim()
    if (!workspaceRoot) return
    const subscriptionKey = key(event.sender, workspaceRoot)
    subscriptions.get(subscriptionKey)?.()
    subscriptions.delete(subscriptionKey)
  })
}
