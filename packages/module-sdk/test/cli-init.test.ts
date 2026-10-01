// `sprintengine-module init`: the command-line door into the scaffolder the
// app's "Build your own extension" flow also uses.
//
// The CLI runs as a real subprocess, bundled from source. The bundle is
// CommonJS, where `import.meta.url` does not exist, so it is pinned to the
// scaffolder's source file: the templates, the skill and the package version
// then resolve from this package exactly as they do from `dist/`.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { buildSync } from 'esbuild'
import { afterAll, beforeAll, describe, test } from 'vitest'

import { EXTENSION_BUILDER_SKILL_DIRS } from '../src/scaffold.js'

const SDK = join(process.cwd(), 'packages/module-sdk')
const SDK_VERSION = (JSON.parse(readFileSync(join(SDK, 'package.json'), 'utf8')) as { version: string }).version

let workDir = ''
let cliBundle = ''

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'sprintengine-cli-init-'))
  cliBundle = join(workDir, 'sprintengine-module.cjs')
  buildSync({
    entryPoints: [join(SDK, 'src/cli.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: cliBundle,
    logLevel: 'silent',
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(join(SDK, 'src/scaffold.ts')).href) },
  })
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

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

describe('sprintengine-module init', () => {
  test('scaffolds a template, taking the id from the folder name', () => {
    const dir = join(workDir, 'Focus Notes')
    const run = runCli(['init', dir, '--template', 'panel'])
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /Created focus-notes from the panel template/)

    const manifest = readJson(join(dir, 'module', 'manifest.json'))
    assert.equal(manifest.id, 'focus-notes')
    assert.equal(manifest.displayName, 'Focus Notes')
    const pkg = readJson(join(dir, 'package.json')) as { devDependencies: Record<string, string> }
    assert.equal(pkg.devDependencies['@sprintengine/module-sdk'], `^${SDK_VERSION}`)
    for (const skillDir of EXTENSION_BUILDER_SKILL_DIRS) {
      assert.equal(existsSync(join(dir, skillDir, 'SKILL.md')), true, `${skillDir} carries the skill`)
    }
    assert.equal(existsSync(join(dir, '.gitignore')), true)
  })

  test('takes --id and --name, and depends on a local tarball when given one', () => {
    const tarball = join(workDir, 'sprintengine-module-sdk-9.9.9.tgz')
    writeFileSync(tarball, 'not really a tarball')
    const dir = join(workDir, 'named')
    const run = runCli([
      'init',
      dir,
      '--template',
      'blank',
      '--id',
      'pomodoro',
      '--name',
      'Pomodoro timer',
      '--sdk-tarball',
      tarball,
    ])
    assert.equal(run.status, 0, run.stderr)
    const manifest = readJson(join(dir, 'module', 'manifest.json'))
    assert.equal(manifest.id, 'pomodoro')
    assert.equal(manifest.displayName, 'Pomodoro timer')
    const pkg = readJson(join(dir, 'package.json')) as { devDependencies: Record<string, string> }
    assert.equal(pkg.devDependencies['@sprintengine/module-sdk'], 'file:vendor/sprintengine-module-sdk-9.9.9.tgz')
    assert.equal(existsSync(join(dir, 'vendor', 'sprintengine-module-sdk-9.9.9.tgz')), true)
  })

  test('without --template, or with an unknown one, it lists the templates', () => {
    const missing = runCli(['init', join(workDir, 'no-template')])
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /requires --template/)
    assert.match(missing.stderr, /panel {2,}/)

    const unknown = runCli(['init', join(workDir, 'unknown'), '--template', 'spreadsheet'])
    assert.equal(unknown.status, 1)
    assert.match(unknown.stderr, /no "spreadsheet" template/)
    assert.match(unknown.stderr, /global-surface {2,}/)
    assert.equal(existsSync(join(workDir, 'unknown')), false)
  })

  test('refuses a folder with files in it unless --force, and a reserved id', () => {
    const dir = join(workDir, 'occupied')
    mkdirSync(dir)
    writeFileSync(join(dir, 'notes.txt'), 'mine')
    const refused = runCli(['init', dir, '--template', 'blank'])
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /already has files in it/)

    const forced = runCli(['init', dir, '--template', 'blank', '--force'])
    assert.equal(forced.status, 0, forced.stderr)
    assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'mine')

    const reserved = runCli(['init', join(workDir, 'reserved'), '--template', 'blank', '--id', 'backlog'])
    assert.equal(reserved.status, 1)
    assert.match(reserved.stderr, /reserved/)
  })
})
