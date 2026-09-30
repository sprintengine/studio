import { ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  SCHEDULED_AGENTS_CHANGED_CHANNEL,
  SCHEDULED_AGENTS_IPC,
  type ScheduledAgentView,
} from '../../shared/scheduled-agents'
import type { ElectronApi } from '../../shared/electron-api'

export const scheduledAgentsApi = {
  listScheduledAgents: () => ipcRenderer.invoke(SCHEDULED_AGENTS_IPC.list),
  createScheduledAgent: (draft) => ipcRenderer.invoke(SCHEDULED_AGENTS_IPC.create, { draft }),
  updateScheduledAgent: (id, draft) => ipcRenderer.invoke(SCHEDULED_AGENTS_IPC.update, { id, draft }),
  removeScheduledAgent: (id) => ipcRenderer.invoke(SCHEDULED_AGENTS_IPC.remove, { id }),
  runScheduledAgentNow: (id) => ipcRenderer.invoke(SCHEDULED_AGENTS_IPC.runNow, { id }),
  markScheduledAgentFailureSeen: (id) => ipcRenderer.invoke(SCHEDULED_AGENTS_IPC.markSeen, { id }),
  onScheduledAgentsChanged: (cb) => {
    const listener = (_event: IpcRendererEvent, agents: ScheduledAgentView[]) => cb(agents)
    ipcRenderer.on(SCHEDULED_AGENTS_CHANGED_CHANNEL, listener)
    return () => ipcRenderer.removeListener(SCHEDULED_AGENTS_CHANGED_CHANNEL, listener)
  },
} satisfies Pick<
  ElectronApi,
  | 'listScheduledAgents'
  | 'createScheduledAgent'
  | 'updateScheduledAgent'
  | 'removeScheduledAgent'
  | 'runScheduledAgentNow'
  | 'markScheduledAgentFailureSeen'
  | 'onScheduledAgentsChanged'
>
