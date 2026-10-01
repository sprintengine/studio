import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { createUpdateInstallNoteStore, installOutcomeFromNote, type UpdateInstallNote } from './update-install-note'

const dirs: string[] = []
function userData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'update-install-note-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const NOW = Date.parse('2026-09-24T12:00:00Z')

function note(overrides: Partial<UpdateInstallNote> = {}): UpdateInstallNote {
  return {
    fromVersion: '0.6.0',
    toVersion: '0.7.0',
    startedAt: new Date(NOW - 60_000).toISOString(),
    platform: 'win32',
    installDir: 'C:\\Program Files\\SprintEngine Studio',
    requiresAdmin: false,
    ...overrides,
  }
}

test('the version that starts is the verdict', () => {
  assert.deepEqual(installOutcomeFromNote(note(), '0.7.0', NOW), {
    kind: 'updated',
    version: '0.7.0',
    fromVersion: '0.6.0',
    message: null,
  })
  const failed = installOutcomeFromNote(note(), '0.6.0', NOW)
  assert.equal(failed?.kind, 'failed')
  assert.equal(failed?.version, '0.7.0')
  assert.match(failed?.message ?? '', /still on 0\.6\.0/)
  // Something else installed over it since: not this note's news.
  assert.equal(installOutcomeFromNote(note(), '0.8.0', NOW), null)
})

test('a failure says why when the app knew, and names the permission an all-users folder needs', () => {
  const reason = installOutcomeFromNote(
    note({ failureReason: 'The installer could not be started: EACCES.' }),
    '0.6.0',
    NOW,
  )
  assert.equal(reason?.message, 'The installer could not be started: EACCES. SprintEngine Studio is still on 0.6.0.')
  const admin = installOutcomeFromNote(note({ requiresAdmin: true }), '0.6.0', NOW)
  assert.match(admin?.message ?? '', /C:\\Program Files\\SprintEngine Studio needs administrator permission/)
})

test('a note from long ago, or from a skewed clock, says nothing', () => {
  assert.equal(
    installOutcomeFromNote(note({ startedAt: new Date(NOW - 2 * 86_400_000).toISOString() }), '0.7.0', NOW),
    null,
  )
  assert.equal(
    installOutcomeFromNote(note({ startedAt: new Date(NOW + 2 * 86_400_000).toISOString() }), '0.7.0', NOW),
    null,
  )
  assert.equal(installOutcomeFromNote(note({ startedAt: 'yesterday' }), '0.7.0', NOW), null)
})

test('a note is written under userData and read back once', () => {
  const dir = userData()
  const store = createUpdateInstallNoteStore({ resolveUserDataDir: () => dir })
  assert.equal(store.consume(), null)
  store.write(note())
  assert.deepEqual(store.consume(), note())
  assert.equal(existsSync(join(dir, 'update-install.json')), false, 'consumed means deleted')
  assert.equal(store.consume(), null)
})

test('a malformed note is dropped without a throw', () => {
  const dir = userData()
  const store = createUpdateInstallNoteStore({ resolveUserDataDir: () => dir })
  writeFileSync(join(dir, 'update-install.json'), '{"fromVersion": 1}')
  assert.equal(store.consume(), null)
  writeFileSync(join(dir, 'update-install.json'), 'not json')
  assert.equal(store.consume(), null)
})
