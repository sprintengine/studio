import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { cliSpawnTarget } from './cli-child-process'

// The spawn plan for an npm-installed CLI, run for real on Windows: a batch
// shim and its PowerShell twin written as npm writes them, beside a script
// that reports what it was given. A chat on This PC in a folder inside a WSL
// distribution runs its agent with a UNC working directory, where the command
// processor cannot start; the admin share (`\\localhost\C$\…`) is a UNC folder
// every Windows runner has. Run through the PowerShell twin, this measured
// stdin held until it closed, its non-ASCII bytes as `?`, CRLF for LF, and
// `model="o3"` and an empty argument mangled. Skipped elsewhere: only Windows
// has shims.

const onWindows = process.platform === 'win32'
// The long name: the runner's temp folder is given in its 8.3 form.
const root = onWindows ? realpathSync.native(mkdtempSync(join(tmpdir(), 'cli-shim-'))) : ''
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

// What `cmd-shim` writes for a package's `bin` (npm 7 and later).
const CMD_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\probe-cli\\cli.js" %*',
  '',
].join('\r\n')

const PS1_SHIM = [
  '#!/usr/bin/env pwsh',
  '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
  '',
  '$exe=""',
  'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {',
  '  $exe=".exe"',
  '}',
  '$ret=0',
  'if (Test-Path "$basedir/node$exe") {',
  '  if ($MyInvocation.ExpectingInput) {',
  '    $input | & "$basedir/node$exe"  "$basedir/node_modules/probe-cli/cli.js" $args',
  '  } else {',
  '    & "$basedir/node$exe"  "$basedir/node_modules/probe-cli/cli.js" $args',
  '  }',
  '  $ret=$LASTEXITCODE',
  '} else {',
  '  if ($MyInvocation.ExpectingInput) {',
  '    $input | & "node$exe"  "$basedir/node_modules/probe-cli/cli.js" $args',
  '  } else {',
  '    & "node$exe"  "$basedir/node_modules/probe-cli/cli.js" $args',
  '  }',
  '  $ret=$LASTEXITCODE',
  '}',
  'exit $ret',
  '',
].join('\n')

// Answers each stdin line at once, as a protocol peer does, then reports its
// argv and folder and exits 7 when stdin closes.
const PROBE = `
const received = []
let pending = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk])
  let newline
  while ((newline = pending.indexOf(0x0a)) !== -1) {
    const line = pending.subarray(0, newline)
    pending = pending.subarray(newline + 1)
    received.push(line.toString('base64'))
    process.stdout.write(Buffer.concat([Buffer.from('echo:'), line, Buffer.from('\\n')]))
  }
})
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), received }) + '\\n')
  process.exitCode = 7
})
`

function uncOf(path: string): string | null {
  const drive = /^([A-Za-z]):\\(.*)$/u.exec(path)
  if (!drive) return null
  const unc = `\\\\localhost\\${drive[1]}$\\${drive[2]}`
  try {
    return statSync(unc).isDirectory() ? unc : null
  } catch {
    return null
  }
}

type Run = { stdout: Buffer; code: number | null; echoedBeforeEnd: boolean }

function run(file: string, args: string[], cwd: string, verbatim: boolean, lines: Buffer[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(verbatim ? { windowsVerbatimArguments: true } : {}),
    })
    const out: Buffer[] = []
    let echoedBeforeEnd = false
    let ended = false
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`no answer in time; stdout so far: ${Buffer.concat(out).toString('utf8')}`))
    }, 60_000)
    child.stdout.on('data', (chunk: Buffer) => {
      out.push(chunk)
      // The first line is answered before stdin closes: the protocol is a
      // conversation, not a batch.
      if (!ended && Buffer.concat(out).includes('echo:')) {
        echoedBeforeEnd = true
        ended = true
        for (const line of lines.slice(1)) child.stdin.write(line)
        child.stdin.end()
      }
    })
    child.stderr.on('data', () => undefined)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout: Buffer.concat(out), code, echoedBeforeEnd })
    })
    child.stdin.write(lines[0])
    // A wrapper that holds stdin until it closes never answers the first line;
    // close it after a while so the run still reports what did arrive.
    setTimeout(() => {
      if (ended) return
      ended = true
      for (const line of lines.slice(1)) child.stdin.write(line)
      child.stdin.end()
    }, 15_000)
  })
}

test.skipIf(!onWindows)(
  'an npm CLI started in a UNC folder runs there, with its arguments, stdio bytes and exit code as they were',
  async () => {
    const bin = join(root, 'bin')
    mkdirSync(join(bin, 'node_modules', 'probe-cli'), { recursive: true })
    writeFileSync(join(bin, 'node_modules', 'probe-cli', 'cli.js'), PROBE)
    writeFileSync(join(bin, 'probe.cmd'), CMD_SHIM)
    writeFileSync(join(bin, 'probe.ps1'), PS1_SHIM)
    const folder = join(root, 'repo with space')
    mkdirSync(folder)
    const unc = uncOf(folder)
    expect(unc, `the admin share should reach ${folder}`).not.toBeNull()

    const args = [
      'app-server',
      '--listen',
      'stdio://',
      'two words',
      '-c',
      'model="o3"',
      '',
      '--',
      '&;$`(x)|<>^',
      'trailing\\',
      'ünïcødé ✓',
    ]
    const lines = [Buffer.from('{"id":1,"text":"héllo ✓ 日本"}\n', 'utf8'), Buffer.from('{"id":2}\r\n', 'utf8')]
    const target = cliSpawnTarget(join(bin, 'probe.cmd'), args, { platform: 'win32', env: process.env, cwd: unc! })
    const result = await run(target.file, target.args, unc!, target.windowsVerbatimArguments === true, lines)
    const text = result.stdout.toString('utf8')
    const last = text.trim().split('\n').at(-1) ?? ''
    expect(last.startsWith('{"argv"'), `the CLI reports what it was given; it wrote ${JSON.stringify(text)}`).toBe(true)
    const report = JSON.parse(last) as { argv: string[]; cwd: string; received: string[] }

    expect.soft(report.cwd.toLowerCase(), 'the CLI runs in the folder it was given').toBe(unc!.toLowerCase())
    expect.soft(report.argv, 'every argument arrives as it was given').toEqual(args)
    expect
      .soft(
        report.received.map((line) => Buffer.from(line, 'base64').toString('utf8')),
        'stdin arrives byte for byte',
      )
      .toEqual(['{"id":1,"text":"héllo ✓ 日本"}', '{"id":2}\r'])
    expect.soft(result.stdout.subarray(0, 5).toString('utf8'), 'stdout starts with the CLI’s own bytes').toBe('echo:')
    expect.soft(text, 'stdout keeps its bytes').toContain('echo:{"id":1,"text":"héllo ✓ 日本"}\n')
    expect.soft(result.echoedBeforeEnd, 'a line is answered before stdin closes').toBe(true)
    expect.soft(result.code, 'the exit code is the CLI’s').toBe(7)
  },
)
