// Round-trip acceptance test for the `multicode-module` CLI.
//
// Proves the signer and the app verifier can never disagree by running BOTH
// paths over the same on-disk fixtures:
//   1. CLI sign → the app's real trust flow (parse + verify + classify)
//      accepts the module as 'signed'.
//   2. A tampered manifest is rejected by CLI `verify` AND by the app verify
//      code, reading the identical fixture bytes.
//   3. `pack` fails with actionable errors on invalid manifests (bad id,
//      reserved bundled id, malformed permissions, missing entry file) and
//      never copies key material.
//
// The CLI is exercised as a real subprocess (bundled from source with esbuild,
// the same toolchain `npm run build` uses) so argument parsing, exit codes,
// and the manifest bytes written to disk are all covered.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildSync } from 'esbuild'

import { BUNDLED_MODULE_IDS } from '../src/index.js'
// App-side trust flow: the exact modules the Multicode app uses on install.
import { parseThirdPartyModuleManifest } from '../../../src/shared/modules/third-party-manifest'
import { parseMarketplacePluginManifest } from '../../../src/shared/marketplace'
import { classifySignedManifestTrust, verifyModuleSignature } from '../../../src/main/modules/module-signature'

const workDir = mkdtempSync(join(tmpdir(), 'multicode-cli-roundtrip-'))
const cliBundle = join(workDir, 'multicode-module.cjs')

buildSync({
  entryPoints: [join(process.cwd(), 'packages/module-sdk/src/cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: cliBundle,
})

type CliRun = { status: number | null; stdout: string; stderr: string }

function runCli(args: string[], cwd: string = workDir): CliRun {
  const { status, stdout, stderr } = spawnSync(process.execPath, [cliBundle, ...args], {
    cwd,
    encoding: 'utf8',
  })
  return { status, stdout, stderr }
}

let fixtureCount = 0

// Raw manifest keys are deliberately unordered relative to the canonical
// (sorted) payload, so a passing round trip also proves key-order independence.
function writeModuleFixture(manifest: Record<string, unknown>): string {
  const dir = join(workDir, `module-${fixtureCount++}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  if (
    typeof manifest.entry === 'object' &&
    manifest.entry !== null &&
    typeof (manifest.entry as Record<string, unknown>).main === 'string'
  ) {
    writeFileSync(join(dir, (manifest.entry as Record<string, string>).main), 'module.exports.registerMain = () => {}\n')
  }
  return dir
}

function validFixtureManifest(): Record<string, unknown> {
  return {
    version: 1,
    permissions: ['network'],
    id: 'cli-roundtrip-fixture',
    entry: { main: 'main.cjs' },
    displayName: 'CLI Roundtrip Fixture',
  }
}

const keyPath = join(workDir, 'signing.key')

function testKeygen(): void {
  const first = runCli(['keygen', '--out', keyPath])
  assert.equal(first.status, 0, first.stderr)
  assert.ok(readFileSync(keyPath, 'utf8').startsWith('-----BEGIN PRIVATE KEY-----'))
  assert.match(first.stdout, /fingerprint/i)
  // Refuses to overwrite an existing key without --force.
  const second = runCli(['keygen', '--out', keyPath])
  assert.equal(second.status, 1)
  assert.match(second.stderr, /--force/)
}

// AC: a module signed with the CLI verifies as 'signed' in the app's real
// trust flow (parse from disk bytes → verify → classify).
function testCliSignThenAppTrustFlowAccepts(): string {
  const moduleDir = writeModuleFixture(validFixtureManifest())
  const signed = runCli(['sign', moduleDir, '--key', keyPath])
  assert.equal(signed.status, 0, signed.stderr)

  const diskBytes = readFileSync(join(moduleDir, 'manifest.json'), 'utf8')
  const parsed = parseThirdPartyModuleManifest(diskBytes)
  assert.ok(parsed.ok, 'app parser must accept the manifest the CLI wrote')
  const { valid, fingerprint } = verifyModuleSignature(parsed.manifest)
  assert.equal(valid, true, 'app verify code must accept the CLI signature')
  assert.equal(typeof fingerprint, 'string')
  const trust = classifySignedManifestTrust(parsed.manifest, { trustedModules: new Map() })
  assert.equal(trust.status, 'signed')

  // CLI verify agrees with the app on the same fixture.
  const verified = runCli(['verify', moduleDir])
  assert.equal(verified.status, 0, verified.stderr)
  assert.match(verified.stdout, /signature valid/)
  assert.ok(verified.stdout.includes(fingerprint!), 'CLI reports the same signer fingerprint the app computes')
  return moduleDir
}

// sign writes the VALIDATED manifest back to disk: unknown keys are stripped,
// so the bytes the author distributes are exactly what the app verifies.
function testSignNormalizesManifestOnDisk(): void {
  const moduleDir = writeModuleFixture({ ...validFixtureManifest(), homepage: 'https://example.com' })
  const signed = runCli(['sign', moduleDir, '--key', keyPath])
  assert.equal(signed.status, 0, signed.stderr)
  const written = JSON.parse(readFileSync(join(moduleDir, 'manifest.json'), 'utf8')) as Record<string, unknown>
  assert.equal(written.homepage, undefined, 'unknown keys must not survive into the signed manifest')
  assert.equal(runCli(['verify', moduleDir]).status, 0)
}

// AC: CLI verify rejects a tampered manifest the same way the app does —
// both paths read the identical tampered fixture bytes.
function testTamperRejectedByBothPaths(signedModuleDir: string): void {
  const manifestPath = join(signedModuleDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  manifest.displayName = 'Evil module'
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  const cliResult = runCli(['verify', signedModuleDir])
  assert.equal(cliResult.status, 1)
  assert.match(cliResult.stderr, /INVALID signature/)

  const parsed = parseThirdPartyModuleManifest(readFileSync(manifestPath, 'utf8'))
  assert.ok(parsed.ok)
  assert.equal(verifyModuleSignature(parsed.manifest).valid, false)
  assert.equal(classifySignedManifestTrust(parsed.manifest, { trustedModules: new Map() }).status, 'invalid')
}

function testVerifyRejectsUnsigned(): void {
  const moduleDir = writeModuleFixture(validFixtureManifest())
  const unsignedVerify = runCli(['verify', moduleDir])
  assert.equal(unsignedVerify.status, 1)
  assert.match(unsignedVerify.stderr, /unsigned/)
}

// AC: pack fails with actionable errors on invalid manifests — never silent.
function testPackRejectsInvalidManifests(): void {
  const badId = runCli(['pack', writeModuleFixture({ ...validFixtureManifest(), id: 'Bad_ID!' })])
  assert.equal(badId.status, 1)
  assert.match(badId.stderr, /id must be lowercase/)

  const reservedId = BUNDLED_MODULE_IDS[0]
  const reserved = runCli(['pack', writeModuleFixture({ ...validFixtureManifest(), id: reservedId })])
  assert.equal(reserved.status, 1)
  assert.match(reserved.stderr, /reserved id, publisher-locked/)

  // Publisher-locked, not absolutely blocked: the first-party publish
  // pipeline packs a reserved id with the explicit opt-in flag (the app
  // still verifies the first-party signature at install).
  const allowed = runCli(['pack', writeModuleFixture({ ...validFixtureManifest(), id: reservedId }), '--allow-reserved-id'])
  assert.equal(allowed.status, 0, allowed.stderr)

  const badPermissions = runCli(['pack', writeModuleFixture({ ...validFixtureManifest(), permissions: 'network' })])
  assert.equal(badPermissions.status, 1)
  assert.match(badPermissions.stderr, /permissions must be an array/)

  const missingEntryDir = writeModuleFixture(validFixtureManifest())
  rmSync(join(missingEntryDir, 'main.cjs'))
  const missingEntry = runCli(['pack', missingEntryDir])
  assert.equal(missingEntry.status, 1)
  assert.match(missingEntry.stderr, /entry\.main.*does not exist/)
}

// pack copies an installable module directory and never packs key material.
function testPackHappyPathExcludesKeyMaterial(): void {
  const moduleDir = writeModuleFixture(validFixtureManifest())
  assert.equal(runCli(['sign', moduleDir, '--key', keyPath]).status, 0)
  // A stray key inside the module dir must not be distributed.
  writeFileSync(join(moduleDir, 'leaked-signing.key'), 'not really a key')
  const outDir = join(workDir, 'packed-fixture')
  const packed = runCli(['pack', moduleDir, '--out', outDir])
  assert.equal(packed.status, 0, packed.stderr)
  assert.ok(existsSync(join(outDir, 'manifest.json')))
  assert.ok(existsSync(join(outDir, 'main.cjs')))
  assert.equal(existsSync(join(outDir, 'leaked-signing.key')), false, 'key files are never packed')
  // The packed copy still verifies — what ships is what the app checks.
  assert.equal(runCli(['verify', outDir]).status, 0)
}

function testPluginScaffoldSignVerifyPackAndAppTrustFlowAccepts(): string {
  const pluginDir = join(workDir, 'marketplace-plugin-fixture')
  const scaffold = runCli(['plugin', 'scaffold', 'marketplace-plugin-fixture', '--out', pluginDir])
  assert.equal(scaffold.status, 0, scaffold.stderr)
  assert.ok(existsSync(join(pluginDir, 'plugin.json')))
  assert.ok(existsSync(join(pluginDir, 'mcp', 'server.json')))
  assert.ok(existsSync(join(pluginDir, 'skills', 'marketplace-plugin-fixture', 'SKILL.md')))
  assert.ok(existsSync(join(pluginDir, 'module', 'manifest.json')))
  assert.ok(existsSync(join(pluginDir, 'cli', 'plugin.json')))
  const scaffoldedMcp = JSON.parse(readFileSync(join(pluginDir, 'mcp', 'server.json'), 'utf8')) as {
    servers?: Array<{ source?: string }>
  }
  assert.equal(scaffoldedMcp.servers?.[0]?.source, 'custom', 'scaffolded marketplace MCPs must not look bundled')

  const signed = runCli(['plugin', 'sign', pluginDir, '--key', keyPath])
  assert.equal(signed.status, 0, signed.stderr)

  const diskBytes = readFileSync(join(pluginDir, 'plugin.json'), 'utf8')
  const parsed = parseMarketplacePluginManifest(diskBytes)
  assert.ok(parsed.ok, 'app parser must accept the plugin manifest the CLI wrote')
  if (!parsed.ok) return pluginDir
  assert.equal(parsed.manifest.components.mcp?.files?.[0]?.path, 'mcp/server.json')
  assert.equal(typeof parsed.manifest.components.mcp?.files?.[0]?.sha256, 'string')
  const { valid, fingerprint } = verifyModuleSignature(parsed.manifest)
  assert.equal(valid, true, 'app verify code must accept the CLI plugin signature')
  assert.equal(typeof fingerprint, 'string')
  const trust = classifySignedManifestTrust(parsed.manifest, { trustedModules: new Map() })
  assert.equal(trust.status, 'signed')

  const verified = runCli(['plugin', 'verify', pluginDir])
  assert.equal(verified.status, 0, verified.stderr)
  assert.match(verified.stdout, /plugin signature valid/)
  assert.ok(verified.stdout.includes(fingerprint!), 'CLI reports the same plugin signer fingerprint the app computes')

  writeFileSync(join(pluginDir, 'leaked-plugin.key'), 'not really a key')
  const outDir = join(workDir, 'packed-plugin-fixture')
  const packed = runCli(['plugin', 'pack', pluginDir, '--out', outDir])
  assert.equal(packed.status, 0, packed.stderr)
  assert.ok(existsSync(join(outDir, 'plugin.json')))
  assert.ok(existsSync(join(outDir, 'mcp', 'server.json')))
  assert.equal(existsSync(join(outDir, 'leaked-plugin.key')), false, 'key files are never packed')
  assert.equal(runCli(['plugin', 'verify', outDir]).status, 0)

  writeFileSync(join(outDir, 'stale-signing.pem'), 'stale key material from an earlier pack')
  writeFileSync(join(outDir, 'cli', 'stale-plugin.key'), 'stale key material from an earlier pack')
  const forced = runCli(['plugin', 'pack', pluginDir, '--out', outDir, '--force'])
  assert.equal(forced.status, 0, forced.stderr)
  assert.equal(existsSync(join(outDir, 'stale-signing.pem')), false, 'force pack must remove stale .pem files')
  assert.equal(existsSync(join(outDir, 'cli', 'stale-plugin.key')), false, 'force pack must remove stale .key files')
  assert.equal(runCli(['plugin', 'verify', outDir]).status, 0)
  return pluginDir
}

function testPluginComponentTamperRejectedByCliVerify(signedPluginDir: string): void {
  writeFileSync(join(signedPluginDir, 'mcp', 'server.json'), `${JSON.stringify({ servers: [] }, null, 2)}\n`)

  const cliResult = runCli(['plugin', 'verify', signedPluginDir])
  assert.equal(cliResult.status, 1)
  assert.match(cliResult.stderr, /component digests/i)

  const parsed = parseMarketplacePluginManifest(readFileSync(join(signedPluginDir, 'plugin.json'), 'utf8'))
  assert.ok(parsed.ok)
  if (!parsed.ok) return
  assert.equal(verifyModuleSignature(parsed.manifest).valid, true, 'component-byte tampering does not mutate plugin.json')
  assert.equal(classifySignedManifestTrust(parsed.manifest, { trustedModules: new Map() }).status, 'signed')
}

function testPluginTamperRejectedByBothPaths(signedPluginDir: string): void {
  const manifestPath = join(signedPluginDir, 'plugin.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  manifest.displayName = 'Tampered Marketplace Plugin'
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  const cliResult = runCli(['plugin', 'verify', signedPluginDir])
  assert.equal(cliResult.status, 1)
  assert.match(cliResult.stderr, /INVALID signature/)

  const parsed = parseMarketplacePluginManifest(readFileSync(manifestPath, 'utf8'))
  assert.ok(parsed.ok)
  if (!parsed.ok) return
  assert.equal(verifyModuleSignature(parsed.manifest).valid, false)
  assert.equal(classifySignedManifestTrust(parsed.manifest, { trustedModules: new Map() }).status, 'invalid')
}

function testPluginVerifyRejectsUnsigned(): void {
  const pluginDir = join(workDir, 'unsigned-plugin-fixture')
  assert.equal(runCli(['plugin', 'scaffold', 'unsigned-plugin-fixture', '--out', pluginDir, '--component', 'mcp']).status, 0)
  const unsignedVerify = runCli(['plugin', 'verify', pluginDir])
  assert.equal(unsignedVerify.status, 1)
  assert.match(unsignedVerify.stderr, /unsigned/)
}

function testPluginPackRejectsMissingComponent(): void {
  const pluginDir = join(workDir, 'missing-component-plugin-fixture')
  assert.equal(runCli(['plugin', 'scaffold', 'missing-component-plugin-fixture', '--out', pluginDir, '--component', 'mcp']).status, 0)
  assert.equal(runCli(['plugin', 'sign', pluginDir, '--key', keyPath]).status, 0)
  rmSync(join(pluginDir, 'mcp', 'server.json'))
  const packed = runCli(['plugin', 'pack', pluginDir])
  assert.equal(packed.status, 1)
  assert.match(packed.stderr, /declared path.*does not exist/)
}

try {
  testKeygen()
  const signedModuleDir = testCliSignThenAppTrustFlowAccepts()
  testSignNormalizesManifestOnDisk()
  testTamperRejectedByBothPaths(signedModuleDir)
  testVerifyRejectsUnsigned()
  testPackRejectsInvalidManifests()
  testPackHappyPathExcludesKeyMaterial()
  const signedPluginDir = testPluginScaffoldSignVerifyPackAndAppTrustFlowAccepts()
  testPluginComponentTamperRejectedByCliVerify(signedPluginDir)
  testPluginTamperRejectedByBothPaths(signedPluginDir)
  testPluginVerifyRejectsUnsigned()
  testPluginPackRejectsMissingComponent()
  console.log('multicode-module CLI round-trip tests passed')
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
