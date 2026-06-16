import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { validateManifestStructure } from './plugin-manifest-validate'
import { validateCliPluginManifest } from '../../packages/module-sdk/src/cli-manifest'

// CLI manifest validation is single-sourced in the SDK; the app's
// validateManifestStructure delegates its CLI branch to validateCliPluginManifest.
// These tests (1) pin the accept/reject behavior on a corpus so a future change
// to the validator can't silently change what the app loads, and (2) assert the
// app and the SDK reach the SAME verdict for every case — the drift guard that
// keeps the published authoring contract and the app's loader in lockstep.

const VALID_CLI = {
  id: 'demo-cli',
  displayName: 'Demo CLI',
  version: 1,
  binary: 'demo',
  permissionPresets: { default: { label: 'Default', args: [] } },
  launch: { argv: ['demo', { spreadIf: 'extraArgs' }] },
  promptInjection: { mode: 'positional-arg' },
  completion: { mode: 'process-exit' },
  capabilities: { resumeSession: false, sessionIdFromCaller: false, toolUse: false, mcpServers: false },
} as const

function without<K extends string>(base: Record<string, unknown>, key: K): Record<string, unknown> {
  const clone = { ...base }
  delete clone[key]
  return clone
}

// Each invalid case isolates one rule. Both validators must reject all of them.
const INVALID_CASES: Array<{ name: string; manifest: unknown }> = [
  { name: 'bad id', manifest: { ...VALID_CLI, id: 'Bad Id' } },
  { name: 'missing binary', manifest: without(VALID_CLI, 'binary') },
  { name: 'missing displayName', manifest: without(VALID_CLI, 'displayName') },
  { name: 'non-positive version', manifest: { ...VALID_CLI, version: 0 } },
  { name: 'empty permissionPresets', manifest: { ...VALID_CLI, permissionPresets: {} } },
  { name: 'empty launch.argv', manifest: { ...VALID_CLI, launch: { argv: [] } } },
  { name: 'output-sentinel without sentinel', manifest: { ...VALID_CLI, completion: { mode: 'output-sentinel' } } },
  { name: 'send-after-ready without readiness', manifest: { ...VALID_CLI, promptInjection: { mode: 'send-after-ready' } } },
  { name: 'missing capabilities boolean', manifest: { ...VALID_CLI, capabilities: { resumeSession: true, sessionIdFromCaller: true, toolUse: true } } },
  { name: 'provider-only field present', manifest: { ...VALID_CLI, providerType: 'model-provider' } },
  { name: 'bad variable type', manifest: { ...VALID_CLI, variables: { x: { type: 'nope', label: 'X' } } } },
  { name: 'native skill without install targets', manifest: { ...VALID_CLI, skillIntegration: { support: 'native', harnessId: 'demo' } } },
  {
    name: 'skill workspace path missing {{skillId}}',
    manifest: {
      ...VALID_CLI,
      skillIntegration: {
        support: 'native',
        harnessId: 'demo',
        installTargets: [{ scope: 'workspace', format: 'generic', path: 'skills/' }],
      },
    },
  },
]

function bundledCliManifests(): Array<{ id: string; source: string }> {
  const root = join(process.cwd(), 'resources', 'plugins')
  if (!existsSync(root)) return []
  const out: Array<{ id: string; source: string }> = []
  for (const entry of readdirSync(root)) {
    const manifestPath = join(root, entry, 'plugin.json')
    if (!existsSync(manifestPath)) continue
    const source = readFileSync(manifestPath, 'utf8')
    // Only the CLI manifests; provider manifests are validated separately.
    if ((JSON.parse(source) as { kind?: string }).kind === 'provider') continue
    out.push({ id: entry, source })
  }
  return out
}

test('accepts every bundled CLI manifest the app ships', () => {
  const manifests = bundledCliManifests()
  assert.ok(manifests.length > 0, 'expected at least one bundled CLI manifest')
  for (const { id, source } of manifests) {
    const result = validateManifestStructure(JSON.parse(source))
    assert.equal(result.ok, true, `${id} should validate: ${result.ok ? '' : JSON.stringify(result.issues)}`)
  }
})

test('accepts the minimal valid CLI manifest', () => {
  assert.equal(validateManifestStructure(VALID_CLI).ok, true)
})

test('rejects every crafted-invalid manifest', () => {
  for (const { name, manifest } of INVALID_CASES) {
    assert.equal(validateManifestStructure(manifest).ok, false, `${name} should be rejected`)
  }
})

test('app and SDK reach the same verdict for every case (no drift)', () => {
  const cases: Array<{ name: string; manifest: unknown }> = [
    { name: 'valid', manifest: VALID_CLI },
    ...bundledCliManifests().map(({ id, source }) => ({ name: `bundled:${id}`, manifest: JSON.parse(source) })),
    ...INVALID_CASES,
  ]
  for (const { name, manifest } of cases) {
    const app = validateManifestStructure(manifest).ok
    const sdk = validateCliPluginManifest(manifest).ok
    assert.equal(app, sdk, `app/SDK verdict drift on "${name}": app=${app} sdk=${sdk}`)
  }
})
