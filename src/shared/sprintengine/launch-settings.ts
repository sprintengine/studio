/**
 * Agent-launch settings mirrored from the renderer to the main process
 * (sprint-runtime-ownership Phase 2). The main-process sprint scheduler spawns
 * agents with the same launch inputs the renderer supervisor used —
 * user-configured CLI runtime overrides, MCP settings, and project knowledge
 * roots — but those live in renderer localStorage (`appSettings`). The
 * renderer pushes them here on change; main persists a copy under userData so
 * a fresh app boot (before any window pushes) still launches with the
 * last-known settings.
 */
import type { McpSettings } from './agent-state'

export type SprintEngineLaunchCliRuntimeSettings = {
  command: string
  useWsl: boolean
  models?: string[]
}

export type SprintEngineLaunchSettings = {
  cliRuntimes: Record<string, SprintEngineLaunchCliRuntimeSettings>
  mcp: McpSettings
  projectKnowledgeRoots: Record<string, string | null>
}

export function emptySprintEngineLaunchSettings(): SprintEngineLaunchSettings {
  return {
    cliRuntimes: {},
    mcp: { syncEnabled: false, servers: {} },
    projectKnowledgeRoots: {},
  }
}

/**
 * Fail-soft parse of a persisted mirror payload. Unknown fields are dropped;
 * missing fields default to empty. Never throws.
 */
export function normalizeSprintEngineLaunchSettings(raw: unknown): SprintEngineLaunchSettings {
  const empty = emptySprintEngineLaunchSettings()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty
  const record = raw as Record<string, unknown>
  const cliRuntimes: SprintEngineLaunchSettings['cliRuntimes'] = {}
  if (record.cliRuntimes && typeof record.cliRuntimes === 'object' && !Array.isArray(record.cliRuntimes)) {
    for (const [cli, value] of Object.entries(record.cliRuntimes as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const entry = value as Record<string, unknown>
      if (typeof entry.command !== 'string') continue
      cliRuntimes[cli] = {
        command: entry.command,
        useWsl: entry.useWsl === true,
        ...(Array.isArray(entry.models)
          ? { models: entry.models.filter((model): model is string => typeof model === 'string') }
          : {}),
      }
    }
  }
  const mcp = record.mcp && typeof record.mcp === 'object' && !Array.isArray(record.mcp)
    ? record.mcp as McpSettings
    : empty.mcp
  const projectKnowledgeRoots: Record<string, string | null> = {}
  if (
    record.projectKnowledgeRoots
    && typeof record.projectKnowledgeRoots === 'object'
    && !Array.isArray(record.projectKnowledgeRoots)
  ) {
    for (const [key, value] of Object.entries(record.projectKnowledgeRoots as Record<string, unknown>)) {
      if (typeof value === 'string' || value === null) projectKnowledgeRoots[key] = value
    }
  }
  return { cliRuntimes, mcp, projectKnowledgeRoots }
}
