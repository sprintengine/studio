import type { IpcRendererEvent } from 'electron'
import { ipc as ipcRenderer } from '../ipc-router'
import type { ElectronApi } from '../../shared/electron-api'
import type { UsageLimitsState } from '../../shared/usage-limits'
import { USAGE_LIMITS_CHANGED_CHANNEL, USAGE_LIMITS_GET_CHANNEL } from '../../shared/ipc/usage-limits'

// `onUsageLimitsChanged` returns the unsubscribe, so a window can let go of
// the push when nothing in it draws the limits any more.
export const usageLimitsApi = {
  usageLimits: (): Promise<UsageLimitsState> => ipcRenderer.invoke(USAGE_LIMITS_GET_CHANNEL),
  onUsageLimitsChanged: (listener: (state: UsageLimitsState) => void): (() => void) => {
    const handler = (_: IpcRendererEvent, state: UsageLimitsState): void => listener(state)
    ipcRenderer.on(USAGE_LIMITS_CHANGED_CHANNEL, handler)
    return () => ipcRenderer.removeListener(USAGE_LIMITS_CHANGED_CHANNEL, handler)
  },
} satisfies Pick<ElectronApi, 'usageLimits' | 'onUsageLimitsChanged'>
