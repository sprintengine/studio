import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'vitest'

import { describeRipgrepSpawnFailure, locateRipgrep, unpackedAsarPath } from './ripgrep-binary'

const WINDOWS_INSTALL = 'C:\\Users\\dev\\AppData\\Local\\Programs\\SprintEngine Studio\\resources'
const MAC_INSTALL = '/Applications/SprintEngine Studio.app/Contents/Resources'

test('a packaged Windows path is moved out of app.asar and keeps its .exe', () => {
  assert.equal(
    unpackedAsarPath(`${WINDOWS_INSTALL}\\app.asar\\node_modules\\@vscode\\ripgrep-win32-x64\\bin\\rg.exe`),
    `${WINDOWS_INSTALL}\\app.asar.unpacked\\node_modules\\@vscode\\ripgrep-win32-x64\\bin\\rg.exe`,
  )
})

test('a packaged macOS path is moved out of app.asar', () => {
  assert.equal(
    unpackedAsarPath(`${MAC_INSTALL}/app.asar/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg`),
    `${MAC_INSTALL}/app.asar.unpacked/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg`,
  )
})

test('a dev path, an already-unpacked path and a look-alike name are left alone', () => {
  const dev = '/Users/dev/studio/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg'
  assert.equal(unpackedAsarPath(dev), dev)
  const unpacked = `${MAC_INSTALL}/app.asar.unpacked/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg`
  assert.equal(unpackedAsarPath(unpacked), unpacked)
  const lookAlike = '/Users/dev/myapp.asar/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg'
  assert.equal(unpackedAsarPath(lookAlike), lookAlike)
})

test('the packaged binary is located at its unpacked path', async () => {
  const checked: string[] = []
  const located = await locateRipgrep({
    load: async () => ({
      rgPath: `${WINDOWS_INSTALL}\\app.asar\\node_modules\\@vscode\\ripgrep-win32-x64\\bin\\rg.exe`,
    }),
    exists: (path) => {
      checked.push(path)
      return true
    },
  })
  const expected = `${WINDOWS_INSTALL}\\app.asar.unpacked\\node_modules\\@vscode\\ripgrep-win32-x64\\bin\\rg.exe`
  assert.deepEqual(located, { ok: true, path: expected })
  assert.deepEqual(checked, [expected], 'existence is checked on the path that will be spawned, not the archive one')
})

test('the dev binary is located where the package resolved it', async () => {
  const dev = '/Users/dev/studio/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg'
  assert.deepEqual(await locateRipgrep({ load: async () => ({ rgPath: dev }), exists: () => true }), {
    ok: true,
    path: dev,
  })
})

test('a binary the install did not unpack is reported, with the path that was expected', async () => {
  const located = await locateRipgrep({
    load: async () => ({ rgPath: `${MAC_INSTALL}/app.asar/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg` }),
    exists: () => false,
  })
  assert.equal(located.ok, false)
  assert.match(!located.ok ? located.message : '', /ripgrep is missing from this install/)
  assert.match(!located.ok ? located.message : '', /app\.asar\.unpacked/)
})

test('a platform package that was never installed is reported instead of crashing the caller', async () => {
  const located = await locateRipgrep({
    load: async () => {
      throw new Error('Could not find @vscode/ripgrep-win32-x64.')
    },
    exists: () => true,
  })
  assert.equal(located.ok, false)
  assert.match(
    !located.ok ? located.message : '',
    /ripgrep isn't installed .*Could not find @vscode\/ripgrep-win32-x64/,
  )
})

test('a spawn failure names the binary rather than the raw errno', () => {
  const error = Object.assign(new Error('spawn C:\\x\\rg.exe ENOENT'), { code: 'ENOENT' })
  assert.deepEqual(describeRipgrepSpawnFailure('C:\\x\\rg.exe', error), {
    message: "Search can't run: ripgrep at C:\\x\\rg.exe could not be started (ENOENT).",
    unusable: true,
  })
})

test('a passing shortage is reported as it is, and does not give up on the binary', () => {
  const error = Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' })
  assert.deepEqual(describeRipgrepSpawnFailure('/x/rg', error), { message: 'spawn EMFILE', unusable: false })
})

test('the packaging config unpacks every platform ripgrep binary the rewrite points at', () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    build: { asarUnpack?: string[] }
  }
  assert.ok(
    pkg.build.asarUnpack?.includes('node_modules/@vscode/ripgrep-*/bin/**'),
    'without it the binary is outside app.asar only when the packager guesses it is one',
  )
})
