/**
 * Production child env for engine and terminal spawns.
 *
 * `SPRINTENGINE_TEST_BUNDLED_WORKFLOW_ROLES` is pytest/Node-test-only
 * (MC-2507 lander 2026-09-16). Production discovery still reads it, so a host
 * launched from a shell that exported it would resolve the packaged seed in
 * Python while app pickers stayed empty — the 2026-09-08 no-fallback ruling,
 * split by process. Every production spawn copies the host env through this
 * helper, which deletes the variable. A test harness that wants it on *that*
 * child passes it again in `overrides`.
 */

export const TEST_BUNDLED_WORKFLOW_ROLES_ENV = 'SPRINTENGINE_TEST_BUNDLED_WORKFLOW_ROLES'

export function productionChildEnv(
  base: NodeJS.ProcessEnv = process.env,
  overrides?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  delete env[TEST_BUNDLED_WORKFLOW_ROLES_ENV]
  return overrides ? { ...env, ...overrides } : env
}
