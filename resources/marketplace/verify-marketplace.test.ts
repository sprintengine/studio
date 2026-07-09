import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildSync } from 'esbuild'

const workDir = mkdtempSync(join(tmpdir(), 'multicode-marketplace-publish-'))
const verifierBundle = join(process.cwd(), 'node_modules', '.cache', 'multicode', 'marketplace-registry-verify-for-test.cjs')
const seedRoot = join(process.cwd(), 'resources', 'marketplace')
const registryWorkflowPath = join(seedRoot, '.github', 'workflows', 'marketplace-registry.yml')

mkdirSync(join(process.cwd(), 'node_modules', '.cache', 'multicode'), { recursive: true })
buildSync({
  entryPoints: [join(process.cwd(), 'resources', 'marketplace', 'verify-marketplace.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  outfile: verifierBundle,
})

type VerifyRun = {
  status: number | null
  stdout: string
  stderr: string
}

function copySeedRegistry(name: string): string {
  const root = join(workDir, name)
  mkdirSync(root, { recursive: true })
  cpSync(seedRoot, root, { recursive: true })
  return root
}

function runVerifier(root: string): VerifyRun {
  const result = spawnSync(process.execPath, [verifierBundle, '--root', root], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function testSampleRegistryPasses(): void {
  const root = copySeedRegistry('valid-registry')
  const result = runVerifier(root)
  assert.equal(result.status, 0, result.stderr)
  // The seed is generated from the HotStack catalogue snapshot: the 4 signed
  // Multicode Labs bundles plus the unsigned plugin/inline-MCP population.
  const seed = JSON.parse(readFileSync(join(seedRoot, 'marketplace.json'), 'utf8')) as { plugins: unknown[] }
  assert.ok(seed.plugins.length >= 4, 'seed registry must carry at least the signed bundles')
  assert.match(result.stdout, new RegExp(`marketplace registry verified \\(${seed.plugins.length} plugins\\)`))
}

function testUnsignedEntriesNeedNoLocalManifest(): void {
  // Unsigned source-bearing entries (the generated claude-plugins-official
  // population) verify without a plugins/<id>/ manifest dir and with a
  // data-URI icon; a signed entry with a missing manifest still fails.
  const root = copySeedRegistry('unsigned-registry')
  const path = join(root, 'marketplace.json')
  const marketplace = JSON.parse(readFileSync(path, 'utf8')) as {
    plugins: Array<Record<string, unknown>>
  }
  const unsigned = marketplace.plugins.filter((plugin) => plugin.signature === undefined)
  assert.ok(unsigned.length > 0, 'generated seed must carry unsigned entries')
  for (const plugin of unsigned) {
    assert.ok(plugin.mcp !== undefined || typeof plugin.source === 'string')
  }
  const signed = marketplace.plugins.find((plugin) => plugin.signature !== undefined)
  assert.ok(signed, 'generated seed must carry a signed entry')
  rmSync(join(root, 'plugins', signed.id as string), { recursive: true, force: true })
  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, new RegExp(`plugins/${signed.id as string}/plugin.json`))
}

function testStrippedSignatureCannotOrphanAPayload(): void {
  // Deleting the signature field from a signed entry must NOT let its
  // committed plugins/<id>/ payload skip CLI verification: the orphan sweep
  // fails the registry instead.
  const root = copySeedRegistry('stripped-signature-registry')
  const path = join(root, 'marketplace.json')
  const marketplace = JSON.parse(readFileSync(path, 'utf8')) as {
    plugins: Array<Record<string, unknown>>
  }
  const signed = marketplace.plugins.find((plugin) => plugin.signature !== undefined)
  assert.ok(signed, 'generated seed must carry a signed entry')
  delete signed.signature
  writeFileSync(path, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf8')

  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, new RegExp(`plugins/${signed.id as string}`))
  assert.match(result.stderr, /no SIGNED marketplace\.json entry/)
}

function testSchemaInvalidRegistryFailsClearly(): void {
  const root = copySeedRegistry('invalid-schema-registry')
  const path = join(root, 'marketplace.json')
  const marketplace = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  marketplace.schemaVersion = 99
  writeFileSync(path, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf8')

  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /marketplace\.json\.schemaVersion/)
  assert.match(result.stderr, /schemaVersion must be 1/)
}

function testTamperedPluginFailsThroughCliVerify(): void {
  const root = copySeedRegistry('tampered-registry')
  const path = join(root, 'plugins', 'browser-automation-mcp', 'plugin.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  manifest.displayName = 'Tampered Browser Automation MCP'
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /plugins\/browser-automation-mcp\/plugin\.json/)
  assert.match(result.stderr, /multicode-module plugin verify failed/)
  assert.match(result.stderr, /INVALID signature/)
}

function testTamperedComponentFailsThroughCliVerify(): void {
  const root = copySeedRegistry('tampered-component-registry')
  const path = join(root, 'plugins', 'browser-automation-mcp', 'mcp', 'server.json')
  const component = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  component.servers = []
  writeFileSync(path, `${JSON.stringify(component, null, 2)}\n`, 'utf8')

  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /plugins\/browser-automation-mcp\/plugin\.json/)
  assert.match(result.stderr, /multicode-module plugin verify failed/)
  assert.match(result.stderr, /component digests/i)
}

function testEntrySourceOnNonAllowlistedHostFails(): void {
  const root = copySeedRegistry('evil-source-registry')
  const path = join(root, 'marketplace.json')
  const marketplace = JSON.parse(readFileSync(path, 'utf8')) as { plugins: Array<{ id: string; source?: string }> }
  const target = marketplace.plugins.find((plugin) => plugin.id === 'browser-automation-mcp')
  assert.ok(target, 'seed registry must carry the browser-automation-mcp bundle')
  target.source = 'https://evil.example.com/plugins/browser-automation-mcp'
  writeFileSync(path, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf8')

  const result = runVerifier(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /plugins\.browser-automation-mcp\.source/)
  assert.match(result.stderr, /allowlist/)
}

function testEntrySourceOnAllowlistedNonCanonicalOwnerPasses(): void {
  const root = copySeedRegistry('non-canonical-owner-registry')
  const path = join(root, 'marketplace.json')
  const marketplace = JSON.parse(readFileSync(path, 'utf8')) as { plugins: Array<{ id: string; source?: string }> }
  const first = marketplace.plugins.find((plugin) => plugin.id === 'browser-automation-mcp')
  assert.ok(first, 'seed registry must carry the browser-automation-mcp bundle')
  first.source = `https://github.com/another-org/registry/tree/main/plugins/${first.id}`
  writeFileSync(path, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf8')

  const result = runVerifier(root)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /marketplace registry verified/)
}

function testPublishScriptsTargetRegistryRoot(): void {
  const appPackage = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  const verifyScript = appPackage.scripts?.['verify:marketplace-registry'] ?? ''
  assert.match(verifyScript, /verify-marketplace\.ts/)
  assert.doesNotMatch(verifyScript, /--root resources\/marketplace/)

  const workflow = readFileSync(registryWorkflowPath, 'utf8')
  assert.match(workflow, /marketplace\.json/)
  assert.match(workflow, /plugins\/\*\*/)
  assert.match(workflow, /trusted-publishers\.json/)
  assert.match(workflow, /--root "\$GITHUB_WORKSPACE\/registry"/)
  assert.doesNotMatch(workflow, /resources\/marketplace/)
}

try {
  testSampleRegistryPasses()
  testUnsignedEntriesNeedNoLocalManifest()
  testStrippedSignatureCannotOrphanAPayload()
  testSchemaInvalidRegistryFailsClearly()
  testTamperedPluginFailsThroughCliVerify()
  testTamperedComponentFailsThroughCliVerify()
  testEntrySourceOnNonAllowlistedHostFails()
  testEntrySourceOnAllowlistedNonCanonicalOwnerPasses()
  testPublishScriptsTargetRegistryRoot()
  console.log('marketplace publish validation tests passed')
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
