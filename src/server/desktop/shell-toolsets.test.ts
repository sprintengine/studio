import assert from 'node:assert/strict'
import { test } from 'vitest'

import { STUDIO_RESERVED_TOOLSET_NAMES } from '../../../packages/studio-protocol/src/tools'
import { createAutomationTools, type AutomationBackends } from '../../main/automation/automation-tools'
import { SHELL_TOOLSETS, isShellToolName, serverAutomationTools, shellTerminalToolsets } from './shell-toolsets'

// Out of process the gateway's automation tools split between the server and
// the shell's toolsets (phase 6, 6.3). An agent must list the same tools
// either way, so the split loses none, doubles none, and leaves no family
// half on each side (a family the server serves refuses the shell's offer).

// Building the registrations reads no backend; only a call would.
const backends = {} as AutomationBackends

test('the split keeps every automation tool exactly once', () => {
  const all = createAutomationTools(backends).map((tool) => tool.name)
  const server = serverAutomationTools(backends).map((tool) => tool.name)
  const shell = shellTerminalToolsets(backends).flatMap((toolset) => toolset.registrations.map((tool) => tool.name))
  assert.deepEqual([...server, ...shell].sort(), [...all].sort())
  assert.equal(new Set([...server, ...shell]).size, all.length)
  assert.ok(shell.includes('agent.launch') && shell.includes('terminal.create'))
  // Its family is the server's, so it stays there and launches through the bridge.
  assert.ok(server.includes('backlog.work'))
})

test('no family is served on both sides', () => {
  const serverFamilies = new Set(serverAutomationTools(backends).map((tool) => tool.name.split('.')[0]))
  for (const name of SHELL_TOOLSETS) assert.equal(serverFamilies.has(name), false, name)
  for (const toolset of shellTerminalToolsets(backends))
    for (const tool of toolset.registrations) assert.ok(tool.name.startsWith(`${toolset.name}.`), tool.name)
})

test('every shell toolset is a reserved name, so no app can take one', () => {
  for (const name of SHELL_TOOLSETS) assert.ok(STUDIO_RESERVED_TOOLSET_NAMES.includes(name), name)
  assert.equal(isShellToolName('agent.launch'), true)
  assert.equal(isShellToolName('backlog.work'), false)
  assert.equal(isShellToolName('agent'), false)
})
