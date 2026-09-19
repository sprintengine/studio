import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultUserSkillsDir, ensureDefaultUserSkillsDir } from './user-skills-dir'
import { test } from 'vitest'

test('user-skills-dir', async () => {
  const home = mkdtempSync(join(tmpdir(), 'user-skills-dir-'))
  assert.equal(defaultUserSkillsDir(home), join(home, '.sprintengine', 'skills'))
  const created = ensureDefaultUserSkillsDir(home)
  assert.equal(created, join(home, '.sprintengine', 'skills'))
  assert.equal(ensureDefaultUserSkillsDir(home), created, 'creating twice is a no-op')
  rmSync(home, { recursive: true, force: true })
  console.log('user-skills-dir.test.ts passed')
})
