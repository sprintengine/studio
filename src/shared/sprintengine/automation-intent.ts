/**
 * The persisted Sprint Engine automation *intent* record — the authoritative,
 * main-owned source of truth for a run's automation mode (`automation.json`
 * beside `run.yaml`).
 *
 * Only the intent lives here (mode + revision + provenance). Runtime lifecycle
 * state (`runtimeState`, reasons) stays renderer-derived while the auto-run
 * loop is renderer-driven; the scheduler phases extend this file.
 *
 * Pure data logic: parsing, normalization, and successor-record math. All fs
 * and clock access lives in `src/main/sprintengine-automation-service.ts`.
 */
import type { SprintEngineAutomationMode } from './automation-types'
import type { SprintEngineRosterSession } from './run-types'
import { isSprintEngineAutomationMode } from './automation-lifecycle'

export const SPRINT_ENGINE_AUTOMATION_INTENT_FILE = 'automation.json'
export const SPRINT_ENGINE_AUTOMATION_INTENT_SCHEMA_VERSION = 1

export type SprintEngineAutomationIntentActor = 'ui' | 'mobile' | 'system' | 'automation'

export type SprintEngineAutomationIntentWrite = {
  actor: SprintEngineAutomationIntentActor
  deviceId: string | null
  at: string
}

/**
 * Scheduler-owned durable runtime residue (sprint-runtime-ownership Phase 3):
 * the main scheduler persists its cross-restart bookkeeping here so a
 * headless completion/retirement survives even when zero windows exist to
 * mirror it, and a later registration adopts main's own record instead of a
 * stale renderer mirror. Never audited, never broadcast, never bumps the
 * revision — it is bookkeeping beside the intent, not the intent.
 */
export type SprintEngineAutomationRuntimeResidue = {
  deliveredAgentNotificationEventKeys: string[]
  completionTeardownAt?: number
  rosterSessions: Record<string, SprintEngineRosterSession>
}

export type SprintEngineAutomationIntentRecord = {
  schemaVersion: typeof SPRINT_ENGINE_AUTOMATION_INTENT_SCHEMA_VERSION
  // Monotonic per-run write counter. Broadcasts carry it; subscribers ignore
  // anything at or below the revision they already applied and never re-assert
  // local state over a newer revision.
  revision: number
  desiredMode: SprintEngineAutomationMode
  changedAt: number
  lastWrite: SprintEngineAutomationIntentWrite
  runtime?: SprintEngineAutomationRuntimeResidue
}

const intentActors = new Set<SprintEngineAutomationIntentActor>(['ui', 'mobile', 'system', 'automation'])

export function isSprintEngineAutomationIntentActor(
  input: unknown,
): input is SprintEngineAutomationIntentActor {
  return typeof input === 'string' && intentActors.has(input as SprintEngineAutomationIntentActor)
}

/**
 * Parse a raw `automation.json` payload. Returns null for anything that is not
 * a well-formed current-schema record — corrupt or future-schema files are
 * treated as absent (the next write recreates them) rather than guessed at.
 */
export function parseSprintEngineAutomationIntentRecord(
  raw: unknown,
): SprintEngineAutomationIntentRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (record.schemaVersion !== SPRINT_ENGINE_AUTOMATION_INTENT_SCHEMA_VERSION) return null
  if (!isSprintEngineAutomationMode(record.desiredMode)) return null
  const revision = record.revision
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) return null
  const changedAt = typeof record.changedAt === 'number' && Number.isFinite(record.changedAt)
    ? record.changedAt
    : 0
  const rawWrite = record.lastWrite && typeof record.lastWrite === 'object' && !Array.isArray(record.lastWrite)
    ? record.lastWrite as Record<string, unknown>
    : null
  const lastWrite: SprintEngineAutomationIntentWrite = {
    actor: isSprintEngineAutomationIntentActor(rawWrite?.actor) ? rawWrite.actor : 'system',
    deviceId: typeof rawWrite?.deviceId === 'string' && rawWrite.deviceId ? rawWrite.deviceId : null,
    at: typeof rawWrite?.at === 'string' ? rawWrite.at : '',
  }
  return {
    schemaVersion: SPRINT_ENGINE_AUTOMATION_INTENT_SCHEMA_VERSION,
    revision,
    desiredMode: record.desiredMode,
    changedAt,
    lastWrite,
    ...(record.runtime !== undefined ? { runtime: normalizeRuntimeResidue(record.runtime) } : {}),
  }
}

export function normalizeRuntimeResidue(raw: unknown): SprintEngineAutomationRuntimeResidue {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  return {
    deliveredAgentNotificationEventKeys: Array.isArray(record.deliveredAgentNotificationEventKeys)
      ? (record.deliveredAgentNotificationEventKeys as unknown[])
        .filter((key): key is string => typeof key === 'string')
      : [],
    ...(typeof record.completionTeardownAt === 'number'
      ? { completionTeardownAt: record.completionTeardownAt }
      : {}),
    rosterSessions:
      record.rosterSessions && typeof record.rosterSessions === 'object' && !Array.isArray(record.rosterSessions)
        ? record.rosterSessions as Record<string, SprintEngineRosterSession>
        : {},
  }
}

export function nextSprintEngineAutomationIntentRecord(input: {
  current: SprintEngineAutomationIntentRecord | null
  mode: SprintEngineAutomationMode
  actor: SprintEngineAutomationIntentActor
  deviceId?: string | null
  now: number
}): SprintEngineAutomationIntentRecord {
  return {
    schemaVersion: SPRINT_ENGINE_AUTOMATION_INTENT_SCHEMA_VERSION,
    revision: (input.current?.revision ?? 0) + 1,
    desiredMode: input.mode,
    changedAt: input.now,
    lastWrite: {
      actor: input.actor,
      deviceId: input.deviceId ?? null,
      at: new Date(input.now).toISOString(),
    },
    // Mode writes never disturb the scheduler's durable bookkeeping.
    ...(input.current?.runtime !== undefined ? { runtime: input.current.runtime } : {}),
  }
}

export function serializeSprintEngineAutomationIntentRecord(
  record: SprintEngineAutomationIntentRecord,
): string {
  return `${JSON.stringify(record, null, 2)}\n`
}
