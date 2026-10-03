import assert from 'node:assert/strict'
import { test } from 'vitest'

import { wslDriveAdvisory } from './NewAgentPanel'

test('a WSL chat on a Windows drive is advised, never stopped, and nothing else is', () => {
  assert.match(wslDriveAdvisory('wsl:Ubuntu', 'C:\\Users\\dev\\repo', true) ?? '', /clone into ~\//u)
  assert.match(wslDriveAdvisory('wsl:Ubuntu', 'D:/work/repo', true) ?? '', /Linux file system/u)
  assert.equal(wslDriveAdvisory('wsl:Ubuntu', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo', true), null)
  assert.equal(wslDriveAdvisory('local', 'C:\\Users\\dev\\repo', true), null)
  assert.equal(wslDriveAdvisory('wsl:Ubuntu', null, true), null)
})

test('a distribution whose chats run one process each sees New chat as it was', () => {
  assert.equal(wslDriveAdvisory('wsl:Ubuntu', 'C:\\Users\\dev\\repo', false), null)
})
