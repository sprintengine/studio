import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { readModuleOverridesSync, writeModuleOverrides } from '../module-host/enablement-store'
import { forgetModules } from './forget-modules'

test('an uninstalled module leaves no secrets, storage or enablement choice under its id', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'forget-modules-'))
  try {
    await writeModuleOverrides(userData, { 'weather-deck': false, 'other-deck': true })
    mkdirSync(join(userData, 'module-secrets'), { recursive: true })
    writeFileSync(join(userData, 'module-secrets', 'weather-deck.bin'), 'sealed')
    writeFileSync(join(userData, 'module-secrets', 'other-deck.bin'), 'sealed')
    mkdirSync(join(userData, 'module-storage', 'weather-deck'), { recursive: true })
    writeFileSync(join(userData, 'module-storage', 'weather-deck', 'forecast.json'), '{}')
    mkdirSync(join(userData, 'module-storage', 'other-deck'), { recursive: true })
    mkdirSync(join(userData, 'module-data', 'weather-deck', 'cache'), { recursive: true })
    writeFileSync(join(userData, 'module-data', 'weather-deck', 'cache', 'tiles.bin'), 'bytes')
    mkdirSync(join(userData, 'module-data', 'other-deck'), { recursive: true })

    await forgetModules(userData, ['weather-deck', '..', ''])

    assert.deepEqual(readModuleOverridesSync(userData), { 'other-deck': true })
    assert.equal(existsSync(join(userData, 'module-secrets', 'weather-deck.bin')), false)
    assert.equal(existsSync(join(userData, 'module-storage', 'weather-deck')), false)
    assert.equal(existsSync(join(userData, 'module-data', 'weather-deck')), false, 'its data directory goes too')
    assert.equal(existsSync(join(userData, 'module-data', 'other-deck')), true)
    assert.equal(existsSync(join(userData, 'module-secrets', 'other-deck.bin')), true, 'another module keeps its own')
    assert.equal(existsSync(join(userData, 'module-storage', 'other-deck')), true)
    assert.equal(existsSync(join(userData, 'module-storage')), true, 'an unsafe id reaches nothing above')
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
})
