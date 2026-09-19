import assert from 'node:assert/strict'

import {
  clearNewChatDraft,
  mergeDraftConnectors,
  newChatDraftHasContent,
  readNewChatDraft,
  rescopeNewChatDraft,
  resetNewChatDraftsForTests,
  writeNewChatDraft,
} from './newChatDraft'
import { test } from 'vitest'

test('newChatDraft', async () => {
  // The parked New chat draft (new-chat-survives-back-and-forward): what the
  // panel writes through survives the panel, per window, until the chat starts
  // or the person closes the panel on purpose.

  function run(name: string, body: () => void): void {
    resetNewChatDraftsForTests()
    try {
      body()
      console.log(`ok - ${name}`)
    } catch (error) {
      console.error(`not ok - ${name}`)
      throw error
    }
  }

  const image = { id: 'img-1', mediaType: 'image/png', dataBase64: 'AAAA', byteLength: 4, path: '/tmp/shot.png' }
  const skill = { id: 'review', name: 'Review' } as never
  const connector = (id: string) => ({ id, name: id })

  run('nothing is parked until something is written', () => {
    assert.equal(readNewChatDraft('w1'), null)
    assert.equal(newChatDraftHasContent(readNewChatDraft('w1')), false)
  })

  run('writes merge into one draft per window and read back whole', () => {
    writeNewChatDraft('w1', { prompt: 'fix the flaky test', folderPath: '/w/app' })
    writeNewChatDraft('w1', { images: [image] })
    const draft = readNewChatDraft('w1')
    assert.deepEqual(draft, {
      folderPath: '/w/app',
      prompt: 'fix the flaky test',
      images: [image],
      selection: null,
      // The parked engine an ordinary draft has none of: it is written only by a
      // picker that stored nothing (a card's `Go`, item 2473).
      engine: null,
      skills: [],
      mcpServers: [],
    })
    assert.equal(readNewChatDraft('w2'), null, 'another window has its own draft')
    assert.equal(newChatDraftHasContent(draft), true)
  })

  run('an empty prompt with an attached image or a pick still counts as content; defaults alone do not', () => {
    writeNewChatDraft('w1', { prompt: '   ', images: [image] })
    assert.equal(newChatDraftHasContent(readNewChatDraft('w1')), true)
    writeNewChatDraft('w1', { images: [] })
    assert.equal(newChatDraftHasContent(readNewChatDraft('w1')), false, 'whitespace alone is not content')
    writeNewChatDraft('w1', { skills: [skill] })
    assert.equal(newChatDraftHasContent(readNewChatDraft('w1')), true, 'a picked skill is')
    writeNewChatDraft('w1', { skills: [], mcpServers: [connector('railway')] })
    assert.equal(newChatDraftHasContent(readNewChatDraft('w1')), true, 'so is a picked MCP server')
    writeNewChatDraft('w1', { mcpServers: [], selection: { kind: 'general' }, folderPath: '/w/app' })
    assert.equal(
      newChatDraftHasContent(readNewChatDraft('w1')),
      false,
      'an engine row and a project are defaults, not content',
    )
  })

  run('clearing forgets the draft entirely', () => {
    writeNewChatDraft('w1', { prompt: 'hello' })
    clearNewChatDraft('w1')
    assert.equal(readNewChatDraft('w1'), null)
  })

  run('rescoping onto another project keeps the words and drops the project-bound picks', () => {
    writeNewChatDraft('w1', {
      folderPath: '/w/app',
      prompt: 'hello',
      images: [image],
      skills: [skill],
      mcpServers: [connector('railway')],
    })
    const moved = rescopeNewChatDraft('w1', '/w/other')
    assert.equal(moved?.folderPath, '/w/other')
    assert.equal(moved?.prompt, 'hello')
    assert.deepEqual(moved?.images, [image])
    assert.deepEqual(moved?.skills, [], 'skills were synced into the old project')
    assert.deepEqual(moved?.mcpServers, [], 'so were the MCP picks')
  })

  run('rescoping onto the same project (any spelling) leaves the picks alone', () => {
    writeNewChatDraft('w1', { folderPath: '/w/app', skills: [skill], mcpServers: [connector('railway')] })
    const same = rescopeNewChatDraft('w1', '/W/App/')
    assert.deepEqual(same?.skills, [skill])
    assert.deepEqual(same?.mcpServers, [connector('railway')])
    assert.equal(same?.folderPath, '/w/app', 'and keeps the spelling it had')
  })

  run('rescoping a window with no draft mints nothing', () => {
    assert.equal(rescopeNewChatDraft('w1', '/w/app'), null)
    assert.equal(readNewChatDraft('w1'), null)
  })

  run('reopening onto a connector leads with it and never doubles a parked chip', () => {
    assert.deepEqual(mergeDraftConnectors([connector('railway')], [connector('github'), connector('railway')]), [
      connector('railway'),
      connector('github'),
    ])
    assert.deepEqual(mergeDraftConnectors(null, [connector('github')]), [connector('github')])
    assert.deepEqual(mergeDraftConnectors(undefined, undefined), [])
  })

  console.log('newChatDraft.test.ts: ok')
})
