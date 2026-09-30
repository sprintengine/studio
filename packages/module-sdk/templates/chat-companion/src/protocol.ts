// The contract between this module's two halves. entry.main registers the
// channels (`host.registerIpc`), the renderer calls them (`host.invoke`), and
// entry.main pushes `CHANGED_TOPIC` (`host.emit`) when the renderer should read
// again. Channels must start with the module id; the host refuses others.

export const MODULE_ID = '{{id}}'

export const CHANNELS = {
  list: `${MODULE_ID}:list`,
  start: `${MODULE_ID}:start`,
  stop: `${MODULE_ID}:stop`,
} as const

export const CHANGED_TOPIC = 'conversations-changed'

export type StartRequest = { workspaceId: string }
export type StopRequest = { workspaceId: string; agentId: string }

export function isStartRequest(value: unknown): value is StartRequest {
  return typeof value === 'object' && value !== null && typeof (value as StartRequest).workspaceId === 'string'
}

export function isStopRequest(value: unknown): value is StopRequest {
  return isStartRequest(value) && typeof (value as StopRequest).agentId === 'string'
}
