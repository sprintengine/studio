import type { IpcMain } from 'electron'

import {
  USAGE_LIMIT_RESUMES_CHANGED_CHANNEL,
  USAGE_LIMIT_RESUMES_GET_CHANNEL,
  USAGE_LIMIT_RESUMES_UPDATE_CHANNEL,
} from '../../shared/ipc/usage-limit-resume'
import { isRecord } from '../../shared/records'
import type { UsageLimitResumeState, UsageLimitResumeUpdate } from '../../shared/usage-limit-resume'
import type { UsageLimitResumer } from '../usage-limits/resume'

/** The slice of a renderer's webContents the push touches. */
type SubscriberLike = {
  id: number
  isDestroyed: () => boolean
  send: (channel: string, payload: unknown) => void
  once: (event: 'destroyed', listener: () => void) => unknown
}

const MAX_ID_LENGTH = 200

/**
 * `usage-limit-resumes:get` answers with the chats a usage limit stopped and
 * the setting; every change after that is pushed to each window that asked.
 * `usage-limit-resumes:update` schedules, cancels or dismisses one chat's
 * resume, or switches the setting, and answers with the state after it.
 */
export function registerUsageLimitResumeIpc(ipcMain: IpcMain, resumer: UsageLimitResumer): { stop: () => void } {
  const subscribers = new Map<number, SubscriberLike>()
  const subscribe = (event: unknown): void => {
    const sender = (event as { sender?: SubscriberLike } | null)?.sender
    if (sender && !subscribers.has(sender.id) && !sender.isDestroyed()) {
      subscribers.set(sender.id, sender)
      sender.once('destroyed', () => subscribers.delete(sender.id))
    }
  }
  ipcMain.handle(USAGE_LIMIT_RESUMES_GET_CHANNEL, (event) => {
    subscribe(event)
    return resumer.state()
  })
  ipcMain.handle(USAGE_LIMIT_RESUMES_UPDATE_CHANNEL, (_event, input: unknown) => {
    const update = parseUsageLimitResumeUpdate(input)
    return update ? resumer.update(update) : resumer.state()
  })
  const stopRelay = resumer.onChanged((state: UsageLimitResumeState) => {
    for (const [id, sender] of subscribers) {
      if (sender.isDestroyed()) subscribers.delete(id)
      else sender.send(USAGE_LIMIT_RESUMES_CHANGED_CHANNEL, state)
    }
  })
  return {
    stop: () => {
      stopRelay()
      subscribers.clear()
    },
  }
}

/** An update as a window sent it, or null for anything else. */
export function parseUsageLimitResumeUpdate(input: unknown): UsageLimitResumeUpdate | null {
  if (!isRecord(input)) return null
  if (input.kind === 'auto') return typeof input.enabled === 'boolean' ? { kind: 'auto', enabled: input.enabled } : null
  if (input.kind !== 'schedule' && input.kind !== 'cancel' && input.kind !== 'dismiss') return null
  if (!id(input.workspaceId) || !id(input.agentId)) return null
  return { kind: input.kind, workspaceId: input.workspaceId, agentId: input.agentId }
}

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
}
