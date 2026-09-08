import { createHash } from 'crypto'
import type {
  MobileControlCommand,
  MobileSprintEngineCommandResult,
} from './command'

const maxRememberedIdempotencyKeys = 500

type CachedMobileSprintEngineCommandResult = {
  requestHash: string
  result: MobileSprintEngineCommandResult
}

export type RememberedMobileSprintEngineCommandResult =
  | { status: 'miss' }
  | { status: 'conflict' }
  | { status: 'hit'; result: MobileSprintEngineCommandResult }

const idempotencyResults = new Map<string, CachedMobileSprintEngineCommandResult>()

export function requestHashFor(command: MobileControlCommand): string {
  const hashInput = stableJsonStringify({
    protocolVersion: command.protocolVersion,
    type: command.type,
    expectedSnapshotVersion: command.expectedSnapshotVersion ?? null,
    payload: command.payload,
  })
  return createHash('sha256').update(hashInput).digest('hex')
}

function cloneCommandResult(result: MobileSprintEngineCommandResult): MobileSprintEngineCommandResult {
  return JSON.parse(JSON.stringify(result)) as MobileSprintEngineCommandResult
}

export function idempotencyKeyForCommand(workspaceRoot: string, command: MobileControlCommand): string {
  return `${workspaceRoot}:${command.deviceId}:${command.idempotencyKey}`
}

export function rememberedCommandResult(key: string, requestHash: string): RememberedMobileSprintEngineCommandResult {
  const cached = idempotencyResults.get(key)
  if (!cached) return { status: 'miss' }

  if (cached.requestHash !== requestHash) {
    return { status: 'conflict' }
  }

  return {
    status: 'hit',
    result: cloneCommandResult(cached.result),
  }
}

export function rememberCommandResult(
  key: string,
  requestHash: string,
  result: MobileSprintEngineCommandResult
): void {
  idempotencyResults.set(key, {
    requestHash,
    result: cloneCommandResult(result),
  })
  while (idempotencyResults.size > maxRememberedIdempotencyKeys) {
    const oldest = idempotencyResults.keys().next().value as string | undefined
    if (!oldest) break
    idempotencyResults.delete(oldest)
  }
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
