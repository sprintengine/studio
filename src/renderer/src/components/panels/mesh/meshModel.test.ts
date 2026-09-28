import assert from 'node:assert/strict'

import type { MeshTerminal } from '../../../../../shared/tailnet-mesh'
import { meshInputState, meshLinkBadge, meshTerminalStatus, meshTerminalTabName, meshTerminalTitle } from './meshModel'
import { test } from 'vitest'

test('meshModel', async () => {
  const terminal: MeshTerminal = {
    workspaceName: 'atlas',
    git: null,
    sessionId: 'agent-1',
    kind: 'agent',
    workspaceId: 'ws-1',
    agentName: 'Ada',
    cli: 'claude',
    cwd: '/repo',
    processAlive: true,
    suspended: false,
    phase: null,
    phaseSince: null,
  }

  // A watch-only pairing must LOOK watch-only before anything is typed. The
  // listener drops an observe-scoped input frame anyway, so a pane that let a
  // person type would be a pane that swallows their keystrokes silently.
  for (const link of ['live', 'connecting', 'reconnecting', 'offline', 'closed'] as const) {
    const state = meshInputState('observe', link)
    assert.equal(state.canType, false, `observe must never type (${link})`)
    assert.match(state.label ?? '', /Watch only/u)
  }
  assert.equal(meshInputState('none', 'live').canType, false)

  // Control types only while the link is actually up: keystrokes at a dead link
  // belong to a screen state that no longer exists.
  assert.equal(meshInputState('control', 'live').canType, true)
  assert.equal(meshInputState('control', 'live').label, null)
  assert.equal(meshInputState('control', 'reconnecting').canType, false)
  assert.match(meshInputState('control', 'reconnecting').label ?? '', /not being sent/u)
  assert.equal(meshInputState('control', 'closed').canType, false)
  assert.match(meshInputState('control', 'closed').label ?? '', /ended/u)

  // A machine that is not answering is not an error state — a laptop with its lid
  // shut looks exactly like this, and the words say the pane is waiting, not broken.
  assert.equal(meshLinkBadge('offline', null).tone, 'neutral')
  assert.match(meshLinkBadge('offline', null).detail ?? '', /reconnects when it comes back/u)
  assert.equal(meshLinkBadge('reconnecting', null).tone, 'warn')
  assert.equal(meshLinkBadge('live', 'ignored').detail, null, 'a live link adds nothing to the pane')
  // The server's own reason wins over ours when it sent one.
  assert.equal(meshLinkBadge('reconnecting', 'Wi-Fi went away.').detail, 'Wi-Fi went away.')

  // The tab carries the machine name. Provenance is part of the pane's identity,
  // not a tooltip: the same keystroke means different things on two machines.
  assert.equal(meshTerminalTabName('mini', 'Ada'), 'Ada · mini')

  // Paused and exited are separate answers: a paused agent's screen is real and
  // its process is not.
  assert.deepEqual(meshTerminalStatus({ ...terminal, suspended: true }), { label: 'Paused', tone: 'neutral' })
  assert.deepEqual(meshTerminalStatus({ ...terminal, processAlive: false }), { label: 'Exited', tone: 'neutral' })
  assert.deepEqual(meshTerminalStatus({ ...terminal, phase: 'awaiting_input' }), {
    label: 'awaiting input',
    tone: 'good',
  })
  assert.deepEqual(meshTerminalStatus(terminal), { label: 'Running', tone: 'good' })

  assert.equal(meshTerminalTitle(terminal), 'Ada')
  assert.equal(meshTerminalTitle({ ...terminal, agentName: null }), 'Agent')
  assert.equal(meshTerminalTitle({ ...terminal, agentName: null, kind: 'terminal' }), 'Terminal')
})
