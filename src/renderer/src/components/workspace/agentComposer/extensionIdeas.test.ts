// The door's extension ideas are a map of what an extension can be: one for
// each of the SDK's templates, so a template added or removed shows up here.

import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { test } from 'vitest'

import { EXTENSION_IDEAS, EXTENSION_IDEAS_FIRST } from './extensionIdeas'

test('one idea for each SDK template, the first ones each a different surface', () => {
  const templates = readdirSync(join(process.cwd(), 'packages', 'module-sdk', 'templates'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .sort()
  assert.deepEqual(EXTENSION_IDEAS.map((idea) => idea.id).sort(), templates)
  const first = EXTENSION_IDEAS.slice(0, EXTENSION_IDEAS_FIRST).map((idea) => idea.surface)
  assert.equal(new Set(first).size, first.length)
  for (const idea of EXTENSION_IDEAS) {
    assert.ok(!idea.prompt.startsWith('-'), `${idea.id}: a prompt that starts with - reads as a flag`)
  }
})
