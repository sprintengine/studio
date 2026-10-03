import assert from 'node:assert/strict'
import { test } from 'vitest'

import { wslDriveAdvisory } from './NewAgentPanel'

test('a WSL chat on a Windows drive is advised, never stopped, and nothing else is', () => {
  assert.match(wslDriveAdvisory('wsl:Ubuntu', 'C:\\Users\\dev\\repo') ?? '', /clone into ~\//u)
  assert.match(wslDriveAdvisory('wsl:Ubuntu', 'D:/work/repo') ?? '', /Linux file system/u)
  assert.equal(wslDriveAdvisory('wsl:Ubuntu', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'), null)
  assert.equal(wslDriveAdvisory('local', 'C:\\Users\\dev\\repo'), null)
  assert.equal(wslDriveAdvisory('wsl:Ubuntu', null), null)
})
