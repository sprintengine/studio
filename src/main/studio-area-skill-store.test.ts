import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'vitest'

import { createStudioAreaSkillStore } from './studio-area-skill-store'

async function userData(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'sprintengine-area-skills-'))
}

test('a fresh machine has chosen no Studio skill, so none is installed', async () => {
  const store = createStudioAreaSkillStore({ resolveUserDataDir: () => '/nonexistent/userData' })
  assert.deepEqual(store.read(), { enabled: [], dismissed: [] })
  assert.deepEqual(store.enabledSkillDirs(), [])
})

test('a choice survives a restart, and a later store reads it back', async () => {
  const dir = await userData()
  const store = createStudioAreaSkillStore({ resolveUserDataDir: () => dir })
  await store.setEnabled('studio-canvas', true)
  await store.setEnabled('studio-backlog', true)
  await store.dismiss('studio-design-system')

  const later = createStudioAreaSkillStore({ resolveUserDataDir: () => dir })
  // In the catalogue's order, not the order they were switched on.
  assert.deepEqual(later.enabledSkillDirs(), ['studio-backlog', 'studio-canvas'])
  assert.deepEqual(later.read().dismissed, ['studio-design-system'])

  await later.setEnabled('studio-canvas', false)
  const reread = createStudioAreaSkillStore({ resolveUserDataDir: () => dir }).read()
  assert.deepEqual(reread.enabled, ['studio-backlog'])
  // Switched off is answered: the Canvas surface does not offer it again.
  assert.deepEqual(reread.dismissed, ['studio-design-system', 'studio-canvas'])
})

test('listeners hear a change, and only a change', async () => {
  const dir = await userData()
  const store = createStudioAreaSkillStore({ resolveUserDataDir: () => dir })
  const heard: string[][] = []
  store.onChange((choices) => heard.push([...choices.enabled]))
  await store.setEnabled('studio-automations', true)
  await store.setEnabled('studio-automations', true)
  await store.setEnabled('studio-automations', false)
  assert.deepEqual(heard, [['studio-automations'], []])
})

test('a record that cannot be trusted reads as nothing chosen, and unknown ids are dropped', async () => {
  const dir = await userData()
  const path = join(dir, 'studio-area-skills.json')
  await writeFile(path, '{ not json', 'utf8')
  assert.deepEqual(createStudioAreaSkillStore({ resolveUserDataDir: () => dir }).enabledSkillDirs(), [])

  await writeFile(
    path,
    JSON.stringify({ enabled: ['studio-sprints', 'studio-workspaces', 'studio-workspaces', 42] }),
    'utf8',
  )
  const store = createStudioAreaSkillStore({ resolveUserDataDir: () => dir })
  assert.deepEqual(store.enabledSkillDirs(), ['studio-workspaces'])
  await store.dismiss('studio-canvas')
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
    enabled: ['studio-workspaces'],
    dismissed: ['studio-canvas'],
  })
})
