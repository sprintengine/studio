import assert from 'node:assert/strict'

import type { CapabilityManifest } from './manifest'
import { resolveModuleEnablement } from './resolve'

function manifest(id: string, extra: Partial<CapabilityManifest> = {}): CapabilityManifest {
  return { id, displayName: id, version: 1, defaultEnabled: true, ...extra }
}

function main(): void {
  testDefaultsAndExplicitDisable()
  testCoreIgnoresOverride()
  testOverrideEnablesDefaultOff()
  testMissingDependency()
  testDisabledDependency()
  testCascadingExclusion()
  testDependencyOrder()
  testConflict()
  testDuplicateId()
  testCycle()

  console.log('module-resolve tests passed')
}

function testDefaultsAndExplicitDisable(): void {
  const result = resolveModuleEnablement([
    manifest('on', { defaultEnabled: true }),
    manifest('off', { defaultEnabled: false }),
  ])
  assert.deepEqual(result.order, ['on'])
  assert.deepEqual(result.disabled, ['off'])
  assert.deepEqual(result.errors, [])
}

function testCoreIgnoresOverride(): void {
  const result = resolveModuleEnablement(
    [manifest('agent-runtime', { core: true, defaultEnabled: false })],
    { 'agent-runtime': false }
  )
  assert.deepEqual(result.order, ['agent-runtime'], 'core modules cannot be disabled')
}

function testOverrideEnablesDefaultOff(): void {
  const enabled = resolveModuleEnablement([manifest('x', { defaultEnabled: false })], { x: true })
  assert.deepEqual(enabled.order, ['x'])

  const disabled = resolveModuleEnablement([manifest('y', { defaultEnabled: true })], { y: false })
  assert.deepEqual(disabled.order, [])
  assert.deepEqual(disabled.disabled, ['y'])
}

function testMissingDependency(): void {
  const result = resolveModuleEnablement([manifest('a', { dependsOn: ['ghost'] })])
  assert.deepEqual(result.order, [])
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0].code, 'missing_dependency')
  assert.equal(result.errors[0].id, 'a')
}

function testDisabledDependency(): void {
  const result = resolveModuleEnablement([
    manifest('a', { dependsOn: ['b'] }),
    manifest('b', { defaultEnabled: false }),
  ])
  assert.deepEqual(result.order, [], 'a cannot load while its dependency b is disabled')
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0].code, 'disabled_dependency')
  assert.equal(result.errors[0].id, 'a')
  assert.deepEqual(result.disabled, ['b'])
}

function testCascadingExclusion(): void {
  // a -> b -> c, with c disabled. Both b and a must be excluded.
  const result = resolveModuleEnablement([
    manifest('a', { dependsOn: ['b'] }),
    manifest('b', { dependsOn: ['c'] }),
    manifest('c', { defaultEnabled: false }),
  ])
  assert.deepEqual(result.order, [])
  const erroredIds = result.errors.map((error) => error.id).sort()
  assert.deepEqual(erroredIds, ['a', 'b'])
}

function testDependencyOrder(): void {
  const result = resolveModuleEnablement([
    manifest('app', { dependsOn: ['runtime'] }),
    manifest('runtime'),
  ])
  assert.deepEqual(result.order, ['runtime', 'app'], 'dependencies load before dependents')
}

function testConflict(): void {
  const result = resolveModuleEnablement([
    manifest('alpha', { conflictsWith: ['beta'] }),
    manifest('beta', { conflictsWith: ['alpha'] }),
  ])
  // Sorted acceptance: alpha accepted first, beta then conflicts.
  assert.deepEqual(result.order, ['alpha'])
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0].code, 'conflict')
  assert.equal(result.errors[0].id, 'beta')
}

function testDuplicateId(): void {
  const result = resolveModuleEnablement([
    manifest('dup', { summary: 'first' }),
    manifest('dup', { summary: 'second' }),
  ])
  assert.deepEqual(result.order, ['dup'])
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0].code, 'duplicate_id')
}

function testCycle(): void {
  const result = resolveModuleEnablement([
    manifest('a', { dependsOn: ['b'] }),
    manifest('b', { dependsOn: ['a'] }),
  ])
  assert.ok(
    result.errors.some((error) => error.code === 'dependency_cycle'),
    'a cycle must be reported'
  )
}

main()
