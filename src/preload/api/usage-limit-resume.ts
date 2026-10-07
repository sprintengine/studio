import type { IpcRendererEvent } from 'electron'
import { ipc as ipcRenderer } from '../ipc-router'
import type { ElectronApi } from '../../shared/electron-api'
import type { UsageLimitResumeState, UsageLimitResumeUpdate } from '../../shared/usage-limit-resume'
import {
  USAGE_LIMIT_RESUMES_CHANGED_CHANNEL,
  USAGE_LIMIT_RESUMES_GET_CHANNEL,
  USAGE_LIMIT_RESUMES_UPDATE_CHANNEL,
} from '../../shared/ipc/usage-limit-resume'

// `onUsageLimitResumesChanged` returns the unsubscribe, so a window can let go
// of the push when nothing in it draws a resume any more.
export const usageLimitResumeApi = {
  usageLimitResumes: (): Promise<UsageLimitResumeState> => ipcRenderer.invoke(USAGE_LIMIT_RESUMES_GET_CHANNEL),
  updateUsageLimitResume: (update: UsageLimitResumeUpdate): Promise<UsageLimitResumeState> =>
    ipcRenderer.invoke(USAGE_LIMIT_RESUMES_UPDATE_CHANNEL, update),
  onUsageLimitResumesChanged: (listener: (state: UsageLimitResumeState) => void): (() => void) => {
    const handler = (_: IpcRendererEvent, state: UsageLimitResumeState): void => listener(state)
    ipcRenderer.on(USAGE_LIMIT_RESUMES_CHANGED_CHANNEL, handler)
    return () => ipcRenderer.removeListener(USAGE_LIMIT_RESUMES_CHANGED_CHANNEL, handler)
  },
} satisfies Pick<ElectronApi, 'usageLimitResumes' | 'updateUsageLimitResume' | 'onUsageLimitResumesChanged'>
