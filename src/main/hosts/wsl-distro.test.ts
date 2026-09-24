import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import {
  __resetWslHostForTest,
  decodeWslOutput,
  knownDefaultWslDistro,
  parseWslListVerbose,
  resolveDefaultWslDistro,
  resolveWslDistroForPath,
  wslDistroForPath,
  wslLoginScript,
  wslScriptDescriptor,
  wslSessionPidFileCommand,
  wslSessionPidKey,
} from './wsl-distro'

afterEach(() => __resetWslHostForTest())

// `wsl.exe --list --verbose` as it arrives on a pipe: UTF-16LE, CRLF, and a
// header whose words depend on the Windows display language.
const LIST_TEXT = [
  '  NAME                   STATE           VERSION',
  '* Ubuntu                 Running         2',
  '  Debian                 Stopped         2',
  '  Ubuntu-24.04           Stopped         1',
  '',
].join('\r\n')

test('the distribution list is read from UTF-16LE with or without a byte order mark', () => {
  const bare = Buffer.from(LIST_TEXT, 'utf16le')
  const marked = Buffer.concat([Buffer.from([0xff, 0xfe]), bare])
  for (const bytes of [bare, marked]) assert.equal(decodeWslOutput(bytes), LIST_TEXT)
  // `WSL_UTF8=1` makes wsl.exe print UTF-8 instead.
  assert.equal(decodeWslOutput(Buffer.from(LIST_TEXT, 'utf8')), LIST_TEXT)
})

test('the distribution list names the default by its star, whatever the header says', () => {
  assert.deepEqual(parseWslListVerbose(LIST_TEXT), [
    { name: 'Ubuntu', isDefault: true, state: 'Running', version: 2 },
    { name: 'Debian', isDefault: false, state: 'Stopped', version: 2 },
    { name: 'Ubuntu-24.04', isDefault: false, state: 'Stopped', version: 1 },
  ])
  const localized = LIST_TEXT.replace('NAME                   STATE           VERSION', 'NOM  ÉTAT  VERSION')
  assert.equal(parseWslListVerbose(localized).length, 3)
  assert.deepEqual(parseWslListVerbose('Windows Subsystem for Linux has no installed distributions.\r\n'), [])
})

test('the default distribution is asked for once and then remembered', async () => {
  let runs = 0
  const runList = async () => {
    runs += 1
    return LIST_TEXT
  }
  assert.equal(knownDefaultWslDistro(), null)
  const [a, b] = await Promise.all([resolveDefaultWslDistro({ runList }), resolveDefaultWslDistro({ runList })])
  assert.equal(a, 'Ubuntu')
  assert.equal(b, 'Ubuntu')
  assert.equal(await resolveDefaultWslDistro({ runList }), 'Ubuntu')
  assert.equal(runs, 1, 'concurrent and later callers share the one lookup')
  assert.equal(knownDefaultWslDistro(), 'Ubuntu')
})

test('a failed lookup is retried soon rather than remembered', async () => {
  let now = 1_000
  let answer: string | null = null
  const runList = async () => answer
  assert.equal(await resolveDefaultWslDistro({ runList, now: () => now }), null)
  answer = LIST_TEXT
  assert.equal(await resolveDefaultWslDistro({ runList, now: () => now }), null, 'within the retry window')
  now += 60_000
  assert.equal(await resolveDefaultWslDistro({ runList, now: () => now }), 'Ubuntu')
})

test('a folder inside a distribution names it; any other folder takes the default', async () => {
  const runList = async () => LIST_TEXT
  assert.equal(await resolveWslDistroForPath('\\\\wsl.localhost\\Debian\\home\\dev\\repo', { runList }), 'Debian')
  assert.equal(await resolveWslDistroForPath('\\\\wsl$\\Ubuntu-24.04\\srv', { runList }), 'Ubuntu-24.04')
  assert.equal(await resolveWslDistroForPath('C:\\Users\\dev\\repo', { runList }), 'Ubuntu')
  assert.equal(wslDistroForPath('/home/dev/repo'), 'Ubuntu')
  assert.equal(wslDistroForPath('\\\\wsl.localhost\\Debian\\x'), 'Debian')
})

test('a script goes to sh on stdin, in the Linux home, in the named distribution', () => {
  assert.deepEqual(wslScriptDescriptor('Debian', 'echo hi'), {
    file: 'wsl.exe',
    args: ['-d', 'Debian', '--cd', '~', '--exec', 'sh', '-s'],
    stdin: 'echo hi\n',
  })
  assert.deepEqual(wslScriptDescriptor(null, 'echo hi\n').args, ['--cd', '~', '--exec', 'sh', '-s'])
  assert.deepEqual(wslScriptDescriptor('bad name; rm', 'true').args.slice(0, 1), ['--cd'], 'an odd name is not passed')
})

test('a login script reaches bash unexpanded by the sh that starts it', () => {
  const home = mkdtempSync(join(tmpdir(), 'se-wsl-login-'))
  try {
    const body = `printf '%s|%s\\n' "$0" 'it'"'"'s $HOME'`
    const stdout = execFileSync('sh', ['-s'], {
      input: wslLoginScript(body),
      env: { HOME: home, PATH: process.env.PATH },
      encoding: 'utf8',
    })
    assert.match(stdout.trim().split('\n').at(-1) ?? '', /bash\|it's \$HOME$/u)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the pid file is keyed by the startup script and written by the shell it names', () => {
  assert.equal(
    wslSessionPidKey(
      'C:\\Users\\dev\\AppData\\Roaming\\SprintEngine Studio\\terminal-startup\\sess-1-1700000000000.sh',
    ),
    'sess-1-1700000000000',
  )
  assert.equal(wslSessionPidKey(undefined), null)
  const tmp = mkdtempSync(join(tmpdir(), 'se-wsl-pid-'))
  try {
    // Run the line with the directory pointed into the temp dir: the shell's
    // own pid lands in the file, from a subshell as well, followed by the
    // shell's start time where there is a /proc to read it from (Linux, and so
    // every WSL distribution; macOS has none and writes the pid alone).
    const line = wslSessionPidFileCommand('sess-1').replaceAll('/tmp/sprintengine-studio-$(id -u)', tmp)
    const hasProc = existsSync('/proc/self/stat')
    for (const shell of ['sh', ...(existsSync('/bin/dash') ? ['/bin/dash'] : [])]) {
      const printed = execFileSync(
        shell,
        ['-c', `${line}; echo $$; ${hasProc ? `sed 's/.*) //' /proc/$$/stat | cut -d' ' -f20` : 'echo'}`],
        { encoding: 'utf8' },
      )
      const [pid, started] = printed.split('\n')
      const [writtenPid, writtenStarted] = readFileSync(join(tmp, 'sessions', 'sess-1.pid'), 'utf8')
        .trim()
        .split(' ')
      assert.equal(writtenPid, pid, `${shell}: the shell's own pid`)
      if (hasProc) {
        assert.match(writtenStarted ?? '', /^\d+$/u, `${shell}: a start time`)
        assert.equal(writtenStarted, started, `${shell}: the shell's own start time, not the subshell's`)
      } else {
        assert.equal(writtenStarted, undefined, `${shell}: no start time without /proc`)
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
