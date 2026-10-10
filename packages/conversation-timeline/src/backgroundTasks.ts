// The background work a session's process still runs after its turn ended,
// as `session_updated` reports it (`backgroundTasks`). Shared by the runtime,
// which keeps the process alive and the chat working while it runs, and the
// chat view, which names what the agent is waiting on.

import type { ConversationBackgroundTask, ConversationBackgroundTaskKind } from './protocol.js'
import { asRecord } from './records.js'

const KINDS = new Set<ConversationBackgroundTaskKind>(['command', 'monitor', 'task'])

/**
 * The list a `session_updated` payload carries, or undefined when it carries
 * none: an absent list leaves the one already known in place, and an empty
 * one says nothing runs any more. Malformed entries are left out.
 */
export function readBackgroundTasks(payload: unknown): ConversationBackgroundTask[] | undefined {
  const list = asRecord(payload)?.backgroundTasks
  if (!Array.isArray(list)) return undefined
  const tasks: ConversationBackgroundTask[] = []
  for (const value of list) {
    const record = asRecord(value)
    if (!record || typeof record.taskId !== 'string' || !record.taskId) continue
    if (!KINDS.has(record.kind as ConversationBackgroundTaskKind)) continue
    tasks.push({
      taskId: record.taskId,
      kind: record.kind as ConversationBackgroundTaskKind,
      ...(typeof record.description === 'string' && record.description.trim()
        ? { description: record.description.trim() }
        : {}),
      ...(record.persistent === true ? { persistent: true } : {}),
    })
  }
  return tasks
}

/**
 * Whether one of these will wake the agent, so the chat is not done yet: a
 * monitor with a deadline, or a task the agent is told about when it ends. A
 * command does not (the agent left a dev server running and finished), and
 * neither does a monitor with no deadline, which would hold the chat working
 * for as long as the process lived.
 */
export function backgroundTasksWakeAgent(tasks: readonly ConversationBackgroundTask[] | undefined): boolean {
  return (tasks ?? []).some((task) => task.kind === 'task' || (task.kind === 'monitor' && !task.persistent))
}

const NOUNS: Record<ConversationBackgroundTaskKind, { order: number; one: string; many: string }> = {
  monitor: { order: 0, one: 'monitor', many: 'monitors' },
  task: { order: 1, one: 'background task', many: 'background tasks' },
  command: { order: 2, one: 'command', many: 'commands' },
}

/**
 * The line that names the work: "Waiting on monitor: CI checks",
 * "Running: npm run dev", "Waiting on 2 monitors and 1 command". It waits
 * while something will wake the agent, and only runs when nothing will. A
 * description follows a colon because the agent words it, as often an order
 * to itself ("Watch CI for PR #42") as a name, and either reads after one.
 */
export function describeBackgroundTasks(tasks: readonly ConversationBackgroundTask[]): string | null {
  if (tasks.length === 0) return null
  const waiting = backgroundTasksWakeAgent(tasks)
  if (tasks.length === 1) {
    const [only] = tasks
    const noun = NOUNS[only.kind].one
    if (waiting) return only.description ? `Waiting on ${noun}: ${only.description}` : `Waiting on a ${noun}`
    return only.description ? `Running: ${only.description}` : `Running a ${noun}`
  }
  const counts = new Map<ConversationBackgroundTaskKind, number>()
  for (const task of tasks) counts.set(task.kind, (counts.get(task.kind) ?? 0) + 1)
  const groups = [...counts]
    .sort(([a], [b]) => NOUNS[a].order - NOUNS[b].order)
    .map(([kind, count]) => `${count} ${count === 1 ? NOUNS[kind].one : NOUNS[kind].many}`)
  const joined = groups.length === 1 ? groups[0] : `${groups.slice(0, -1).join(', ')} and ${groups.at(-1)}`
  return `${waiting ? 'Waiting on' : 'Running'} ${joined}`
}
