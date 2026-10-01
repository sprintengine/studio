import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import {
  compareModuleFileDigests,
  validateModuleFileDigests,
  validateThirdPartyModuleManifest,
} from '../src/manifest-validate.js'
import { computeModuleFileDigestsSync, moduleFileDigestIssuesSync } from '../src/signing.js'

const DIGEST = 'a'.repeat(64)
const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempModule(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sdk-module-files-'))
  temps.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

test('a files map of safe paths and sha256 digests validates, sorted', () => {
  const result = validateModuleFileDigests({ 'dist/main.cjs': DIGEST, 'README.md': DIGEST })
  assert.deepEqual(result, { ok: true, files: { 'README.md': DIGEST, 'dist/main.cjs': DIGEST } })
})

test('a files map naming a path a module cannot ship is refused', () => {
  for (const path of ['../escape.cjs', '/etc/passwd', 'dist/./main.cjs', 'dist\\main.cjs', 'manifest.json']) {
    const result = validateModuleFileDigests({ [path]: DIGEST })
    assert.equal(result.ok, false, path)
  }
  for (const path of ['node_modules/x/index.js', '.git/HEAD', 'signing.key', 'certs/tls.pem']) {
    const result = validateModuleFileDigests({ [path]: DIGEST })
    assert.equal(result.ok, false, path)
  }
})

test('a files map with a digest that is not lowercase sha256 hex is refused', () => {
  for (const digest of ['A'.repeat(64), 'a'.repeat(63), 42, null]) {
    assert.equal(validateModuleFileDigests({ 'main.cjs': digest }).ok, false, String(digest))
  }
  assert.equal(validateModuleFileDigests(['main.cjs']).ok, false)
})

test('the manifest validator keeps files only when the manifest has them', () => {
  const base = { id: 'demo', displayName: 'Demo', version: 1 }
  const without = validateThirdPartyModuleManifest(base)
  assert.ok(without.ok)
  if (without.ok) assert.equal('files' in without.manifest, false)
  const withFiles = validateThirdPartyModuleManifest({ ...base, files: { 'main.cjs': DIGEST } })
  assert.ok(withFiles.ok)
  if (withFiles.ok) assert.deepEqual(withFiles.manifest.files, { 'main.cjs': DIGEST })
  assert.equal(validateThirdPartyModuleManifest({ ...base, files: { '../x': DIGEST } }).ok, false)
})

test('comparison is an exact set: missing, changed and unlisted files all count', () => {
  const issues = compareModuleFileDigests(
    { 'a.cjs': DIGEST, 'b.cjs': DIGEST },
    { 'a.cjs': 'b'.repeat(64), 'c.cjs': DIGEST },
  )
  assert.deepEqual(issues, [
    { path: 'files.a.cjs', message: 'does not match the signed digests.' },
    { path: 'files.b.cjs', message: 'listed in the signed digests but missing.' },
    { path: 'files.c.cjs', message: 'is not listed in the signed digests.' },
  ])
})

test('the walk digests every file but the root manifest', () => {
  const root = tempModule({ 'manifest.json': '{}', 'dist/main.cjs': 'x', 'dist/manifest.json': '{}' })
  const result = computeModuleFileDigestsSync(root)
  assert.ok(result.ok)
  assert.deepEqual(Object.keys(result.files), ['dist/main.cjs', 'dist/manifest.json'])
  assert.deepEqual(moduleFileDigestIssuesSync(root, result.files), [])
})

test('the pack walk leaves out what pack leaves out; the installed walk refuses it', () => {
  const root = tempModule({ 'main.cjs': 'x', 'node_modules/dep/index.js': 'y', '.git/HEAD': 'z', 'dev.pem': 'k' })
  const packView = computeModuleFileDigestsSync(root, { walk: 'pack' })
  assert.ok(packView.ok)
  assert.deepEqual(Object.keys(packView.files), ['main.cjs'])
  const installed = computeModuleFileDigestsSync(root)
  assert.equal(installed.ok, false)
  if (!installed.ok) {
    assert.deepEqual(
      installed.issues.map((issue) => issue.path),
      ['files..git', 'files.dev.pem', 'files.node_modules'],
    )
  }
})

test('a missing module folder is an issue, not an empty module', () => {
  const result = computeModuleFileDigestsSync(join(tmpdir(), 'sdk-module-files-does-not-exist'))
  assert.equal(result.ok, false)
})
