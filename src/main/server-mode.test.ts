import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import {
  readServerMode,
  serverModeWindowArguments,
  setSessionServerMode,
  takeServerFallbackNote,
  writeServerFallbackNote,
  writeServerMode,
} from './server-mode'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  setSessionServerMode('in-process')
})
function profile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'se-server-mode-'))
  dirs.push(dir)
  return dir
}

test('in process unless something says otherwise', () => {
  assert.deepEqual(readServerMode(profile(), {}), { mode: 'in-process', source: 'default' })
})

test('the Advanced toggle is read back as written, and the environment overrides it', () => {
  const dir = profile()
  writeServerMode(dir, 'out-of-process')
  assert.deepEqual(readServerMode(dir, {}), { mode: 'out-of-process', source: 'settings' })
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'server-mode.json')).mode & 0o777, 0o600)
  assert.deepEqual(readServerMode(dir, { SPRINTENGINE_SERVER_MODE: 'in-process' }), {
    mode: 'in-process',
    source: 'environment',
  })
})

test('a damaged file or an unknown value is the default', () => {
  const dir = profile()
  writeFileSync(join(dir, 'server-mode.json'), '{ not json')
  assert.equal(readServerMode(dir, {}).mode, 'in-process')
  writeFileSync(join(dir, 'server-mode.json'), '{"mode":"cloud"}')
  assert.equal(readServerMode(dir, { SPRINTENGINE_SERVER_MODE: 'sideways' }).mode, 'in-process')
})

test("every window is started with the session's mode", () => {
  assert.deepEqual(serverModeWindowArguments(), ['--studio-server-mode=in-process'])
  setSessionServerMode('out-of-process')
  assert.deepEqual(serverModeWindowArguments(), ['--studio-server-mode=out-of-process'])
})

test('a launch after one whose server could not start runs in process, and is told why once', () => {
  const dir = profile()
  writeServerMode(dir, 'out-of-process')
  assert.deepEqual(readServerMode(dir, {}, ['electron', '.', '--studio-server-fallback']), {
    mode: 'in-process',
    source: 'fallback',
  })
  writeServerFallbackNote(dir, 'The data directory is not writable.')
  assert.equal(takeServerFallbackNote(dir), 'The data directory is not writable.')
  assert.equal(takeServerFallbackNote(dir), null, 'said once')
  // The setting is untouched: the next ordinary launch tries again.
  assert.equal(readServerMode(dir, {}, []).mode, 'out-of-process')
})
