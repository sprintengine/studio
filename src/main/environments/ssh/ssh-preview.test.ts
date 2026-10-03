import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { sshPreviewFromArgv, SSH_PREVIEW_FILENAME } from '../../../shared/ssh-preview'
import { readSshPreview, writeSshPreview } from './ssh-preview'

test('the SSH machines preview is off unless the switch or the environment turns it on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'se-ssh-preview-'))
  try {
    assert.deepEqual(readSshPreview(dir, {}), { enabled: false, fromEnvironment: false })
    writeSshPreview(dir, true)
    assert.equal(statSync(join(dir, SSH_PREVIEW_FILENAME)).mode & 0o777, 0o600)
    assert.deepEqual(readSshPreview(dir, {}), { enabled: true, fromEnvironment: false })
    assert.deepEqual(readSshPreview(dir, { SPRINTENGINE_SSH_MACHINES: 'off' }), {
      enabled: false,
      fromEnvironment: true,
    })
    writeFileSync(join(dir, SSH_PREVIEW_FILENAME), 'not json')
    assert.equal(readSshPreview(dir, {}).enabled, false, 'a damaged file is off')
    assert.equal(readSshPreview(dir, { SPRINTENGINE_SSH_MACHINES: 'on' }).enabled, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(sshPreviewFromArgv(['electron', '--studio-ssh-machines=on']), true)
  assert.equal(sshPreviewFromArgv(['electron', '--studio-ssh-machines=off']), false)
  assert.equal(sshPreviewFromArgv(['electron']), false)
})
