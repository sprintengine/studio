import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  MACHINE_COLOURS,
  defaultMachineColour,
  defaultMachineKind,
  machineIdOf,
  normalizeMachineMarkSettings,
  resolveMachineIdentity,
} from './machine-identity'
import {
  applyAgentLaunchSettingsPatch,
  emptyAgentLaunchSettings,
  normalizeAgentLaunchSettings,
  normalizeAgentLaunchSettingsPatch,
} from './launch-settings'

test('this machine has no identity, so no surface marks it', () => {
  assert.equal(machineIdOf({ kind: 'local' }), null)
  assert.equal(resolveMachineIdentity({ kind: 'local' }, {}), null)
  assert.equal(resolveMachineIdentity({ kind: 'wsl', hostId: 'local' }, {}), null, 'nor its host id')
})

test('the default kind comes from what the machine is', () => {
  assert.equal(defaultMachineKind({ kind: 'wsl', hostId: 'wsl:Ubuntu' }), 'wsl')
  assert.equal(defaultMachineKind({ kind: 'ssh', host: 'build-box' }), 'server')
  assert.equal(defaultMachineKind({ kind: 'paired', name: 'mac-mini' }), 'mini')
  assert.equal(defaultMachineKind({ kind: 'paired', name: 'dev-macbook-air' }), 'laptop')
  assert.equal(defaultMachineKind({ kind: 'paired', name: 'Dev-MacBook-Pro' }), 'laptop', '"book" beats "pro"')
  assert.equal(defaultMachineKind({ kind: 'paired', name: 'build-box' }), 'desktop', 'any other paired machine')
})

test('the default colour is a hash of the stable id, one of the seven hues, the same wherever it is seen', () => {
  const ids = ['wsl:Ubuntu', 'ssh:build-box', 'tailnet:mac-mini', 'tailnet:dev-macbook-air']
  for (const id of ids) {
    const colour = defaultMachineColour(id)
    assert.ok(MACHINE_COLOURS.slice(0, 7).includes(colour), `${id} lands on a hue, never the neutral`)
    assert.equal(defaultMachineColour(id), colour, 'and lands there every time')
  }
  // Not from list order: the same machines in any order wear the same colours.
  const forward = ids.map(defaultMachineColour)
  const backward = [...ids].reverse().map(defaultMachineColour).reverse()
  assert.deepEqual(forward, backward)
  // The id every device agrees on: a paired machine by its short host name.
  assert.equal(machineIdOf({ kind: 'paired', name: 'Mac-Mini.example.ts.net.' }), 'tailnet:mac-mini')
  assert.equal(
    resolveMachineIdentity({ kind: 'paired', name: 'mac-mini.example.ts.net' }, {})?.colour,
    resolveMachineIdentity({ kind: 'paired', name: 'mac-mini' }, {})?.colour,
    'two devices that spell the host differently show one colour',
  )
  assert.equal(machineIdOf({ kind: 'ssh', host: 'Build-Box' }), 'ssh:build-box')
})

test('an override wins, field by field, and says it was set by the person', () => {
  const machine = { kind: 'ssh', host: 'build-box' } as const
  const plain = resolveMachineIdentity(machine, {})!
  assert.equal(plain.overridden, false)
  const tower = resolveMachineIdentity(machine, { 'ssh:build-box': { kind: 'tower' } })!
  assert.equal(tower.kind, 'tower')
  assert.equal(tower.colour, plain.colour, 'the colour stays the default')
  assert.equal(tower.overridden, true)
  const neutral = resolveMachineIdentity(machine, { 'ssh:build-box': { colour: 'neutral' } })!
  assert.equal(neutral.colour, 'neutral', 'the neutral is a choice a person can make')
  assert.deepEqual(
    normalizeMachineMarkSettings({ a: { kind: 'phone' }, b: { kind: 'board', colour: 'pink' }, c: 'x' }),
    { b: { kind: 'board' } },
    'an unknown kind or colour is dropped, and an empty mark is none',
  )
})

test('overrides persist in the launch settings, per machine, the way host settings do', () => {
  const patch = normalizeAgentLaunchSettingsPatch({
    machineMarks: { 'wsl:Ubuntu': { kind: 'server', colour: 'teal' }, 'ssh:build-box': null },
  })
  const written = applyAgentLaunchSettingsPatch(
    { ...emptyAgentLaunchSettings(), machineMarks: { 'ssh:build-box': { colour: 'red' } } },
    patch,
  )
  assert.deepEqual(written.machineMarks, { 'wsl:Ubuntu': { kind: 'server', colour: 'teal' } }, 'set, and forgotten')
  // Read back from disk, the record carries them.
  const reread = normalizeAgentLaunchSettings(JSON.parse(JSON.stringify(written)))
  assert.deepEqual(reread.machineMarks, written.machineMarks)
  assert.equal(resolveMachineIdentity({ kind: 'wsl', hostId: 'wsl:Ubuntu' }, reread.machineMarks)?.kind, 'server')
})

test('a paired machine known only by its tailnet address keeps the whole address as its id', () => {
  // Pairing falls back to the endpoint's address when Tailscale names no host,
  // and every tailnet IPv4 address starts `100.`: a first label would give all
  // of them one id, one colour, and one override.
  assert.equal(machineIdOf({ kind: 'paired', name: '100.101.102.103' }), 'tailnet:100.101.102.103')
  assert.notEqual(
    machineIdOf({ kind: 'paired', name: '100.101.102.103' }),
    machineIdOf({ kind: 'paired', name: '100.64.0.7' }),
  )
  // A typed name with a full stop in it is a name, not a host to shorten.
  assert.equal(machineIdOf({ kind: 'paired', name: "Dev's MacBook Air. Studio" }), "tailnet:dev's macbook air. studio")
  assert.equal(machineIdOf({ kind: 'paired', name: 'mac-mini.example.ts.net.' }), 'tailnet:mac-mini')
})

test('an SSH machine is keyed by its host, not by the user or port typed in front of it', () => {
  const resolved = machineIdOf({ kind: 'ssh', host: 'build-box' })
  assert.equal(machineIdOf({ kind: 'ssh', host: 'dev@build-box' }), resolved, 'the user is not the machine')
  assert.equal(machineIdOf({ kind: 'ssh', host: 'dev@Build-Box.' }), resolved)
  // Two machines behind one host are told apart by a port that is not 22.
  assert.equal(machineIdOf({ kind: 'ssh', host: 'build-box', port: 22 }), resolved)
  assert.equal(machineIdOf({ kind: 'ssh', host: 'build-box', port: 2222 }), 'ssh:build-box:2222')
  assert.equal(machineIdOf({ kind: 'ssh', host: 'dev@build-box:2222' }), 'ssh:build-box:2222')
  assert.notEqual(
    machineIdOf({ kind: 'ssh', host: 'localhost', port: 2222 }),
    machineIdOf({ kind: 'ssh', host: 'localhost', port: 2223 }),
  )
})

test('the default kind reads whole words of the host name, so a near miss does not look silly', () => {
  assert.equal(defaultMachineKind({ kind: 'paired', name: 'mac-pro' }), 'tower', 'a Mac Pro is a tower')
  assert.equal(defaultMachineKind({ kind: 'paired', name: 'macro-runner' }), 'desktop', '"macro" is not a Mac')
  assert.equal(defaultMachineKind({ kind: 'paired', name: 'ubuntu-studio' }), 'desktop', '"studio" alone is not a Mac')
  assert.equal(defaultMachineKind({ kind: 'paired', name: 'mac-studio' }), 'mini')
  assert.equal(defaultMachineKind({ kind: 'paired', name: 'devs-imac' }), 'desktop')
  assert.equal(defaultMachineKind({ kind: 'paired', name: 'MacBookPro' }), 'laptop')
  assert.equal(defaultMachineKind({ kind: 'paired', name: 'minipc' }), 'mini')
  assert.equal(defaultMachineKind({ kind: 'paired', name: 'mac-mini' }), 'mini')
  assert.equal(defaultMachineKind({ kind: 'paired', name: 'dev-macbook-air' }), 'laptop')
  assert.equal(defaultMachineKind({ kind: 'paired', name: '100.64.0.7' }), 'desktop')
})
