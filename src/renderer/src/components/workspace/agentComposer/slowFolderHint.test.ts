import assert from 'node:assert/strict'
import { test } from 'vitest'

import { defaultNewChatHostId, hostRefusesFolder, slowFolderHint } from './NewAgentPanel'

const UNC = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'

test('a WSL chat on a Windows drive is told, in one short line, which machine is fast', () => {
  assert.equal(
    slowFolderHint('wsl:Ubuntu', 'C:\\Users\\dev\\repo', true),
    'On C: — slow from Ubuntu. Run on This PC for full speed.',
  )
  assert.equal(
    slowFolderHint('wsl:Debian', 'd:/work/repo', true),
    'On D: — slow from Debian. Run on This PC for full speed.',
    'the drive and the distribution are the real ones',
  )
  assert.equal(slowFolderHint('wsl:Ubuntu', UNC, true), null, 'its own disk is the fast one')
  assert.equal(slowFolderHint('local', 'C:\\Users\\dev\\repo', true), null)
  assert.equal(slowFolderHint('wsl:Ubuntu', null, true), null)
})

test('a distribution whose chats run one process each sees New chat on a Windows drive as it was', () => {
  assert.equal(slowFolderHint('wsl:Ubuntu', 'C:\\Users\\dev\\repo', false), null)
})

test('This PC in a folder inside a distribution gets the mirror line', () => {
  const line = 'In Ubuntu — slow from Windows. Run on WSL: Ubuntu for full speed.'
  assert.equal(slowFolderHint('local', UNC, false), line)
  assert.equal(slowFolderHint('local', '\\\\wsl$\\Ubuntu\\home\\dev\\repo', true), line, 'either share spelling')
  assert.equal(
    slowFolderHint('local', '//wsl.localhost/Ubuntu-24.04/home/dev/repo', true),
    'In Ubuntu-24.04 — slow from Windows. Run on WSL: Ubuntu-24.04 for full speed.',
  )
})

test('the machine chosen in the door wins over the folder, on either side (owner ruling 2026-10-03)', () => {
  assert.equal(defaultNewChatHostId(UNC, null), 'wsl:Ubuntu', 'nothing chosen: the folder decides')
  assert.equal(defaultNewChatHostId(UNC, 'wsl:Debian'), 'wsl:Ubuntu', 'a pick from another folder does not carry over')
  assert.equal(defaultNewChatHostId(UNC, null, 'local'), 'local', 'This PC chosen for a folder inside Ubuntu')
  assert.equal(defaultNewChatHostId('C:\\Users\\dev\\repo', 'wsl:Ubuntu'), 'wsl:Ubuntu')
  assert.equal(defaultNewChatHostId('C:\\Users\\dev\\repo', null, 'wsl:Ubuntu'), 'wsl:Ubuntu')
  assert.equal(defaultNewChatHostId('C:\\Users\\dev\\repo', null), 'local')
})

test('only another distribution is refused a folder inside one', () => {
  assert.equal(hostRefusesFolder('local', UNC), null)
  assert.equal(hostRefusesFolder('wsl:Ubuntu', UNC), null)
  assert.equal(hostRefusesFolder('wsl:Ubuntu', 'C:\\Users\\dev\\repo'), null)
  assert.equal(hostRefusesFolder('wsl:Debian', UNC), 'WSL: Debian cannot open a folder inside Ubuntu.')
  assert.equal(hostRefusesFolder('wsl:Debian', null), null)
})
