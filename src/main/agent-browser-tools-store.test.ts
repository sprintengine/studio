import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { createAgentBrowserToolsStore } from './agent-browser-tools-store'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function profile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-browser-tools-'))
  dirs.push(dir)
  return dir
}

test('agents have the browser until the person turns it off', () => {
  assert.equal(createAgentBrowserToolsStore({ resolveUserDataDir: profile }).isEnabled(), true)
})

test('off is kept across launches', () => {
  const dir = profile()
  createAgentBrowserToolsStore({ resolveUserDataDir: () => dir }).set(false)
  assert.equal(createAgentBrowserToolsStore({ resolveUserDataDir: () => dir }).isEnabled(), false)
})

test('an unreadable file leaves the browser on', () => {
  const dir = profile()
  writeFileSync(join(dir, 'agent-browser-tools.json'), '{"enabled":"no"}')
  assert.equal(createAgentBrowserToolsStore({ resolveUserDataDir: () => dir }).isEnabled(), true)
})

test('the gate leaves the browser out of the toolsets waited for, and its tools out of a list, only while it is off', async () => {
  const { agentBrowserToolGate } = await import('./agent-browser-tools-store')
  let enabled = true
  const gate = agentBrowserToolGate(() => enabled)
  const expected = gate.expectedToolsets(['browser', 'canvas', 'editor'])
  assert.deepEqual(expected(), ['browser', 'canvas', 'editor'])
  assert.equal(gate.hidesTool('browser.open'), false)
  enabled = false
  assert.deepEqual(expected(), ['canvas', 'editor'], 'read when asked, not when made')
  assert.equal(gate.hidesTool('browser.open'), true)
  assert.equal(gate.hidesTool('canvas.open'), false)
})

test('the server in its own process reads the switch from the profile afresh each time', async () => {
  const { agentBrowserToolsEnabledOnDisk } = await import('./agent-browser-tools-store')
  const dir = profile()
  assert.equal(agentBrowserToolsEnabledOnDisk(dir), true)
  const store = createAgentBrowserToolsStore({ resolveUserDataDir: () => dir })
  store.set(false)
  assert.equal(agentBrowserToolsEnabledOnDisk(dir), false)
  store.set(true)
  assert.equal(agentBrowserToolsEnabledOnDisk(dir), true)
})
