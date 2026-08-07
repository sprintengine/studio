/**
 * The role -> CLI map a sprint workspace records, normalized (MC-2160).
 *
 * Relocated from the renderer's run-state slice because main normalizes the same
 * map when it composes a sprint workspace headlessly, and the seeded agent
 * records resolve their CLI through it. `runStateSlice.ts` re-exports it so
 * existing renderer import sites are unchanged.
 */
import type { SprintEngineRoleCliDefaults } from '../../renderer/src/types/workspace'

export function defaultSprintEngineRoleCliDefaults(): Required<SprintEngineRoleCliDefaults> {
  return {
    architect: 'claude-code',
    product: 'claude-code',
    frontend: 'claude-code',
    ui_ux_reviewer: 'claude-code',
    developer: 'claude-code',
    performance: 'claude-code',
    production_readiness_reviewer: 'claude-code',
    cross_platform: 'claude-code',
    tester: 'claude-code',
    security: 'claude-code',
  }
}

export function normalizeSprintEngineRoleCliDefaults(
  input: SprintEngineRoleCliDefaults | null | undefined,
): Required<SprintEngineRoleCliDefaults> {
  const defaults = defaultSprintEngineRoleCliDefaults()
  const next = { ...defaults }

  const entries = input && typeof input === 'object'
    ? Object.entries(input)
    : Object.entries(defaults)
  for (const [role, value] of entries) {
    if (typeof value === 'string' && value.trim()) {
      next[role] = value.trim()
    }
  }

  return next
}
