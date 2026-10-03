import assert from 'node:assert/strict'
import { test } from 'vitest'

import { clientToolOriginOf, gatewayToolsetOf } from './clientTools'

const catalog = [
  { name: 'game', title: 'Acme Game', builtIn: false },
  { name: 'browser', title: 'browser', builtIn: true },
]

test('a tool an app offers is labelled with the app, whichever way its CLI spells it', () => {
  assert.equal(clientToolOriginOf('mcp__sprintengine-studio__game_spawn_enemy', catalog), 'Acme Game')
  assert.equal(
    clientToolOriginOf('mcp__plugin_sprintengine-studio_sprintengine-studio__game_spawn', catalog),
    'Acme Game',
  )
  assert.equal(clientToolOriginOf('game.spawn_enemy', catalog), 'Acme Game')
  // Studio's own tools, another server's, and a name no app offers are no app's.
  assert.equal(clientToolOriginOf('mcp__sprintengine-studio__browser_open', catalog), null)
  assert.equal(clientToolOriginOf('mcp__sprintengine-studio__workspace_list', catalog), null)
  assert.equal(clientToolOriginOf('mcp__other__game_spawn_enemy', catalog), null)
  assert.equal(clientToolOriginOf('mcp__sprintengine-studio__notes_add', catalog), null)
  assert.equal(clientToolOriginOf('Bash', catalog), null)
  assert.equal(gatewayToolsetOf('mcp__sprintengine-studio__game_spawn_enemy'), 'game')
})
