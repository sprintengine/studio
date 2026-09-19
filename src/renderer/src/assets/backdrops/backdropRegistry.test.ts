// Completeness check for the per-theme creation backdrops. The registry derives
// its mapping from a Vite glob (import.meta.glob), which only exists under the
// Vite transform — so rather than import the registry, this test validates the
// real asset sets on disk against APP_THEMES: every concrete (resolved) theme
// must ship both a workspace and a chat plate at standard and 4K resolution, and
// there must be no orphan plates for ids that aren't themes. This is what
// guarantees backdropFor never silently returns null for a live theme.

import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { APP_THEMES } from '../../types/appTheme'
import { test } from 'vitest'

test('backdropRegistry', async () => {
  const SURFACES = ['workspace', 'chat'] as const

  const backdropsDir = join(process.cwd(), 'src/renderer/src/assets/backdrops')
  const fourKDir = join(backdropsDir, '4k')
  const standardFiles = new Set(readdirSync(backdropsDir).filter((name) => name.endsWith('.jpg')))
  const fourKFiles = new Set(readdirSync(fourKDir).filter((name) => name.endsWith('.jpg')))

  const resolvedThemes = APP_THEMES.map((theme) => theme.resolved).filter(
    (resolved): resolved is NonNullable<typeof resolved> => resolved !== null,
  )

  // Every concrete theme has both plates.
  for (const theme of resolvedThemes) {
    for (const surface of SURFACES) {
      const file = `backdrop-${theme}-${surface}.jpg`
      assert.ok(standardFiles.has(file), `missing standard backdrop plate: ${file}`)
      assert.ok(fourKFiles.has(file), `missing 4K backdrop plate: ${file}`)
    }
  }

  // Count matches exactly: 2 plates per resolved theme, no orphans. A plate whose
  // theme id was renamed or removed would otherwise linger unreferenced.
  const expected = new Set(
    resolvedThemes.flatMap((theme) => SURFACES.map((surface) => `backdrop-${theme}-${surface}.jpg`)),
  )
  const standardOrphans = [...standardFiles].filter((file) => !expected.has(file))
  const fourKOrphans = [...fourKFiles].filter((file) => !expected.has(file))
  assert.deepEqual(
    standardOrphans,
    [],
    `orphan standard backdrop plates not mapped to any theme: ${standardOrphans.join(', ')}`,
  )
  assert.deepEqual(fourKOrphans, [], `orphan 4K backdrop plates not mapped to any theme: ${fourKOrphans.join(', ')}`)

  assert.equal(standardFiles.size, resolvedThemes.length * SURFACES.length)
  assert.equal(fourKFiles.size, resolvedThemes.length * SURFACES.length)

  console.log(`backdropRegistry: ${resolvedThemes.length} themes × ${SURFACES.length} plates × 2 resolutions verified`)
})
