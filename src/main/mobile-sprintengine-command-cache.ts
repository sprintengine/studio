import { createHash } from 'crypto'
import type {
  MobileControlCommand,
  MobileSwarmCommandResult,
} from './mobile-sprintengine-command'

export function requestHashFor(command: MobileControlCommand): string {
  const hashInput = stableJsonStringify({
    protocolVersion: command.protocolVersion,
    type: command.type,
    expectedSnapshotVersion: command.expectedSnapshotVersion ?? null,
    payload: command.payload,
  })
  return createHash('sha256').update(hashInput).digest('hex')
}

export function cloneCommandResult(result: MobileSwarmCommandResult): MobileSwarmCommandResult {
  return JSON.parse(JSON.stringify(result)) as MobileSwarmCommandResult
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((entry) => stableJsonStringify(entry)).join(',')}]`

  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`)
    .join(',')}}`
}
