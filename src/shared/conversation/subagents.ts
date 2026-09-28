// Reading a spawned agent's lifecycle off the conversation event stream, shared
// by the runtime (which counts background agents) and the chat projection
// (which keeps a background agent's lane open until the agent finishes).

import type { ConversationSubagentState, ConversationSubagentStatusPayload } from '../conversation-runtime'
import { asRecord } from '../records'

// What Claude Code returns at once for an agent launched in the background.
// The text is written for the model ("never quote or paste any part of it"),
// so it is never shown; the agent's real result arrives when it finishes.
const BACKGROUND_LAUNCH_ACK = 'Async agent launched successfully'

export function isBackgroundLaunchAck(output: unknown): boolean {
  return typeof output === 'string' && output.trimStart().startsWith(BACKGROUND_LAUNCH_ACK)
}

const STATES = new Set<ConversationSubagentState>(['running', 'completed', 'failed', 'stopped'])

/** The payload of a `subagent_status` event, or null when it is malformed. */
export function readSubagentStatus(payload: unknown): ConversationSubagentStatusPayload | null {
  const record = asRecord(payload)
  if (!record || typeof record.toolUseId !== 'string' || !record.toolUseId) return null
  if (!STATES.has(record.status as ConversationSubagentState)) return null
  const text = (key: string) => (typeof record[key] === 'string' && record[key] ? (record[key] as string) : undefined)
  const usage = asRecord(record.usage)
  const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  return {
    toolUseId: record.toolUseId,
    status: record.status as ConversationSubagentState,
    ...(text('taskId') ? { taskId: text('taskId') } : {}),
    ...(typeof record.background === 'boolean' ? { background: record.background } : {}),
    ...(text('subagentType') ? { subagentType: text('subagentType') } : {}),
    ...(text('description') ? { description: text('description') } : {}),
    ...(text('lastToolName') ? { lastToolName: text('lastToolName') } : {}),
    ...(text('progressSummary') ? { progressSummary: text('progressSummary') } : {}),
    ...(text('error') ? { error: text('error') } : {}),
    ...(typeof record.endedAt === 'number' ? { endedAt: record.endedAt } : {}),
    ...(usage
      ? {
          usage: {
            totalTokens: count(usage.totalTokens),
            toolUses: count(usage.toolUses),
            durationMs: count(usage.durationMs),
          },
        }
      : {}),
  }
}
