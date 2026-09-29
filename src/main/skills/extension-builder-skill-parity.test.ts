// The extension-builder skill ships twice, and the two must be one skill.
//
// Its source is the SDK's (`packages/module-sdk/skills/`): the npm package
// carries it, and every project `sprintengine-module init` or the app's build
// flow scaffolds gets a copy. The app also offers it machine-wide as a Studio
// area skill (shared/studio-area-skills.ts), which installs from the built-in
// plugin — so the plugin holds a second copy. An agent should not learn a
// different API depending on which door it came through, so the copies are
// held byte for byte: edit the SDK's, then copy it over.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { test } from 'vitest'

import { EXTENSION_BUILDER_SKILL_ID } from '../../shared/extension-scaffold'
import { STUDIO_AREA_SKILLS } from '../../shared/studio-area-skills'
import { STUDIO_PLUGIN_ID } from './studio-plugin'

const SDK_COPY = resolve(process.cwd(), 'packages', 'module-sdk', 'skills', EXTENSION_BUILDER_SKILL_ID)
const PLUGIN_COPY = resolve(
  process.cwd(),
  'resources',
  'studio-plugin',
  STUDIO_PLUGIN_ID,
  'skills',
  EXTENSION_BUILDER_SKILL_ID,
)

function files(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      return entry.isDirectory() ? files(root, path) : [path]
    })
    .sort()
}

test('the Studio plugin’s extension-builder skill is the SDK’s, byte for byte', () => {
  const sdkFiles = files(SDK_COPY)
  assert.ok(sdkFiles.includes('SKILL.md'))
  assert.deepEqual(
    files(PLUGIN_COPY),
    sdkFiles,
    `resources/studio-plugin/${STUDIO_PLUGIN_ID}/skills/${EXTENSION_BUILDER_SKILL_ID} must hold exactly the SDK skill's files — copy packages/module-sdk/skills/${EXTENSION_BUILDER_SKILL_ID} over it`,
  )
  for (const path of sdkFiles) {
    assert.ok(
      readFileSync(join(PLUGIN_COPY, path)).equals(readFileSync(join(SDK_COPY, path))),
      `${path} differs between the SDK's skill and the Studio plugin's copy — edit the SDK's, then copy it over`,
    )
  }
})

test('the Extensions home offers it as an area skill', () => {
  const skill = STUDIO_AREA_SKILLS.find((entry) => entry.id === EXTENSION_BUILDER_SKILL_ID)
  assert.equal(skill?.surface, 'extensions')
})
