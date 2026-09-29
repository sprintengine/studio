import assert from 'node:assert/strict'
import { test } from 'vitest'

import { HOST_API_MIN_SUPPORTED, HOST_API_VERSION } from '../../shared/modules/host-api'
import type { CapabilityManifest, ModuleResolutionErrorCode } from '../../shared/modules/manifest'
import { resolveModuleEnablement } from '../../shared/modules/resolve'
import { applyHostApiGate, computeHostApiIneligible } from './host-api-gate'

function manifest(id: string, extra: Partial<CapabilityManifest> = {}): CapabilityManifest {
  return { id, displayName: id, version: 1, defaultEnabled: true, source: 'third-party', ...extra }
}

test('a third-party module loads only when it names a host API this app provides', () => {
  const modules = [
    manifest('current', { engines: { hostApi: HOST_API_VERSION } }),
    manifest('floor', { engines: { hostApi: HOST_API_MIN_SUPPORTED } }),
    manifest('future', { engines: { hostApi: HOST_API_VERSION + 1 } }),
    manifest('ancient', { engines: { hostApi: HOST_API_MIN_SUPPORTED - 1 } }),
    manifest('unstated'),
    manifest('fractional', { engines: { hostApi: 1.5 } }),
    manifest('bundled', { source: 'bundled' }),
  ]
  assert.deepEqual(computeHostApiIneligible(modules), {
    future: 'incompatible_host_api',
    ancient: 'incompatible_host_api',
    unstated: 'incompatible_host_api',
    fractional: 'incompatible_host_api',
  })
  // The load plan's modules carry their manifest one level down; both shapes read the same.
  assert.deepEqual(
    computeHostApiIneligible(modules.map((entry) => ({ manifest: entry }))),
    computeHostApiIneligible(modules),
  )
})

test('the gate outranks "untrusted" but not an invalid signature', () => {
  const ineligible: Record<string, ModuleResolutionErrorCode> = {
    untrustedFuture: 'untrusted',
    tamperedFuture: 'invalid_signature',
    untrustedCurrent: 'untrusted',
  }
  applyHostApiGate(ineligible, [
    manifest('untrustedFuture', { engines: { hostApi: 99 } }),
    manifest('tamperedFuture', { engines: { hostApi: 99 } }),
    manifest('untrustedCurrent', { engines: { hostApi: HOST_API_VERSION } }),
    manifest('trustedFuture', { engines: { hostApi: 99 } }),
  ])
  assert.deepEqual(ineligible, {
    untrustedFuture: 'incompatible_host_api',
    tamperedFuture: 'invalid_signature',
    untrustedCurrent: 'untrusted',
    trustedFuture: 'incompatible_host_api',
  })
})

test('the resolver keeps a gated module out and says it needs another build', () => {
  const modules = [
    manifest('future', { engines: { hostApi: 99 } }),
    manifest('dependent', { engines: { hostApi: HOST_API_VERSION }, dependsOn: ['future'] }),
  ]
  const ineligible: Record<string, ModuleResolutionErrorCode> = {}
  applyHostApiGate(ineligible, modules)
  const resolution = resolveModuleEnablement(modules, {}, { ineligible })
  assert.deepEqual(resolution.order, [])
  const error = resolution.errors.find((entry) => entry.id === 'future')
  assert.equal(error?.code, 'incompatible_host_api')
  assert.match(error?.message ?? '', /different host API/)
  assert.doesNotMatch(error?.message ?? '', /trust/)
})
