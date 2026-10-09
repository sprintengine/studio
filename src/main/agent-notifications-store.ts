/**
 * The agent-notification setting (shared/agent-notifications.ts), owned by
 * main: the banners are raised here, at moments no renderer may be around to
 * ask. Settings reads and writes it over IPC.
 *
 * One small JSON file under userData, read synchronously and written whole on
 * change, as boolean-file-setting.ts does for the on/off switches; this one
 * has three values. Absent, unreadable or malformed reads as the default.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

import {
  DEFAULT_AGENT_NOTIFICATION_MODE,
  isAgentNotificationMode,
  type AgentNotificationMode,
} from '../shared/agent-notifications'
import { isRecord } from '../shared/records'
import { writeFileAtomicSync } from '../server/platform/atomic-file'
import type { BooleanFileSettingDeps } from './boolean-file-setting'

const FILE_NAME = 'agent-notifications.json'

export type AgentNotificationsStore = {
  mode(): AgentNotificationMode
  /** Idempotent: an unchanged value never rewrites the file. Anything that is not a mode is ignored. */
  set(mode: unknown): void
}

export function createAgentNotificationsStore(deps: BooleanFileSettingDeps): AgentNotificationsStore {
  let cached: AgentNotificationMode | null = null
  const filePath = () => join(deps.resolveUserDataDir(), FILE_NAME)

  function mode(): AgentNotificationMode {
    if (cached !== null) return cached
    try {
      const raw: unknown = JSON.parse(readFileSync(filePath(), 'utf8'))
      cached = isRecord(raw) && isAgentNotificationMode(raw.mode) ? raw.mode : DEFAULT_AGENT_NOTIFICATION_MODE
    } catch {
      cached = DEFAULT_AGENT_NOTIFICATION_MODE
    }
    return cached
  }

  return {
    mode,
    set(next) {
      if (!isAgentNotificationMode(next) || mode() === next) return
      cached = next
      try {
        writeFileAtomicSync(filePath(), `${JSON.stringify({ mode: next })}\n`)
      } catch (error) {
        // It still applies for this session; it just will not survive a restart.
        deps.logDiagnostic?.({
          level: 'warning',
          title: 'Chat notification setting not persisted',
          message:
            'The chat notification setting could not be written to disk; it applies for this session but will not survive a restart.',
          details: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }
}
