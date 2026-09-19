import assert from 'node:assert/strict'
import { SIDECAR_DIR_NAME, sidecarFor, sidecarPath, sidecarRelativePath } from './workspace-sidecar'
import { test } from 'vitest'

test('workspace-sidecar', () => {
  const WORKSPACE = '/Users/dev/projects/studio'
  const WINDOWS_WORKSPACE = 'C:\\Users\\dev\\projects\\studio'

  assert.equal(SIDECAR_DIR_NAME, '.sprintengine')
  assert.equal(sidecarFor(WORKSPACE).root, `${WORKSPACE}/.sprintengine`)

  // Every stored path this app writes is workspace-relative and POSIX, on both
  // platforms, so the absolute form is the only one that may take a backslash.
  assert.equal(
    sidecarPath(sidecarFor(WORKSPACE), 'automations', 'team', 'run.json'),
    `${WORKSPACE}/.sprintengine/automations/team/run.json`,
  )
  assert.equal(
    sidecarPath(sidecarFor(WINDOWS_WORKSPACE), 'automations', 'team', 'run.json'),
    `${WINDOWS_WORKSPACE}\\.sprintengine\\automations\\team\\run.json`,
  )
  assert.equal(sidecarPath(sidecarFor(WORKSPACE)), `${WORKSPACE}/.sprintengine`)

  assert.equal(sidecarRelativePath('backlog', 'config.json'), '.sprintengine/backlog/config.json')
  assert.equal(sidecarRelativePath(), '.sprintengine')
})
