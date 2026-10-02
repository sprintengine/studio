import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, test } from 'vitest'

import { createServerLog } from './server-log'
import { forkUtilityServer, SERVER_SERVICE_NAME, type UtilityForker } from './utility-launcher'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function logsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'se-server-log-'))
  dirs.push(dir)
  return dir
}

test('lines are written whole and timestamped, a partial one waits for the rest', () => {
  const dir = logsDir()
  const log = createServerLog({ logsDir: dir, now: () => new Date('2026-10-02T10:00:00.000Z') })
  log.write('out', 'ready in 40 ms\nhalf a ')
  log.write('out', 'line\n')
  log.write('err', Buffer.from('uncaught: boom\n'))
  log.note('forked out/main/studio-server.js')
  const text = readFileSync(join(dir, 'server-2026-10-02.log'), 'utf8')
  assert.equal(
    text,
    [
      '2026-10-02T10:00:00.000Z ready in 40 ms',
      '2026-10-02T10:00:00.000Z half a line',
      '2026-10-02T10:00:00.000Z [err] uncaught: boom',
      '2026-10-02T10:00:00.000Z [shell] forked out/main/studio-server.js',
      '',
    ].join('\n'),
  )
  assert.deepEqual(log.tail(), [
    'ready in 40 ms',
    'half a line',
    '[err] uncaught: boom',
    '[shell] forked out/main/studio-server.js',
  ])
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'server-2026-10-02.log')).mode & 0o777, 0o600)
  log.close()
})

test('a full file continues in the next part, and a new day starts a new file', () => {
  const dir = logsDir()
  let clock = new Date('2026-10-02T23:59:59.000Z')
  const log = createServerLog({ logsDir: dir, now: () => clock, maxFileBytes: 150 })
  for (let i = 0; i < 4; i++) log.write('out', `${'x'.repeat(40)}\n`)
  clock = new Date('2026-10-03T00:00:01.000Z')
  log.write('out', 'tomorrow\n')
  log.close()
  assert.deepEqual(readdirSync(dir).sort(), [
    'server-2026-10-02.1.log',
    'server-2026-10-02.log',
    'server-2026-10-03.log',
  ])
  for (const file of readdirSync(dir)) assert.ok(statSync(join(dir, file)).size <= 150, file)
})

test('fourteen days are kept, and only the server log is touched', () => {
  const dir = logsDir()
  for (const name of [
    'server-2026-09-01.log',
    'server-2026-09-17.1.log',
    'server-2026-09-18.log',
    'diagnostics-2026-09-01.jsonl',
  ])
    writeFileSync(join(dir, name), 'old\n')
  const log = createServerLog({ logsDir: dir, now: () => new Date('2026-10-02T09:00:00Z') })
  log.write('out', 'start\n')
  log.close()
  assert.deepEqual(readdirSync(dir).sort(), [
    'diagnostics-2026-09-01.jsonl',
    'server-2026-09-18.log',
    'server-2026-10-02.log',
  ])
})

test('the tail keeps the last lines only', () => {
  const log = createServerLog({ logsDir: logsDir(), tailLines: 3 })
  log.write('out', 'one\ntwo\nthree\nfour\n')
  assert.deepEqual(log.tail(), ['two', 'three', 'four'])
  log.close()
})

test('a logs directory that cannot be written still keeps the tail', () => {
  const blocked = join(logsDir(), 'not-a-dir')
  writeFileSync(blocked, '')
  const log = createServerLog({ logsDir: blocked })
  log.write('err', 'still said\n')
  assert.deepEqual(log.tail(), ['[err] still said'])
  assert.equal(log.currentPath(), null)
  log.close()
})

test('the utility launcher forks the bundle by name, pipes its output, and kills a hung one outright', () => {
  const dir = logsDir()
  const log = createServerLog({ logsDir: dir })
  const process = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    posted: [] as unknown[],
    postMessage(message: unknown) {
      this.posted.push(message)
    },
    killedGracefully: false,
    kill() {
      this.killedGracefully = true
      return true
    },
  })
  const forks: unknown[] = []
  const utilityProcess = {
    fork: (modulePath: string, args: string[], options: unknown) => {
      forks.push({ modulePath, args, options })
      return process
    },
  } as unknown as UtilityForker
  const signals: Array<[number, string]> = []
  const child = forkUtilityServer({
    utilityProcess,
    modulePath: '/Applications/SprintEngine Studio.app/Contents/Resources/app.asar/out/main/studio-server.js',
    log,
    killProcess: (pid, signal) => signals.push([pid, signal]),
    platform: 'darwin',
  })
  assert.deepEqual((forks[0] as { options: { serviceName: string; stdio: string } }).options, {
    serviceName: SERVER_SERVICE_NAME,
    stdio: 'pipe',
  })
  assert.equal(child.pid, 4242)
  const messages: unknown[] = []
  child.onMessage((message) => messages.push(message))
  process.emit('message', { t: 'pong' })
  assert.deepEqual(messages, [{ t: 'pong' }])
  child.postMessage({ t: 'ping', seq: 1 })
  assert.deepEqual(process.posted, [{ t: 'ping', seq: 1 }])
  process.stdout.write('ready\n')
  process.stderr.write('warning\n')
  child.kill()
  assert.deepEqual(signals, [[4242, 'SIGKILL']])
  assert.equal(process.killedGracefully, false)
  const exits: unknown[] = []
  child.onExit((exit) => exits.push(exit))
  process.emit('exit', 137)
  assert.deepEqual(exits, [{ code: 137, signal: null }])
  assert.ok(log.tail().includes('ready'))
  assert.ok(log.tail().includes('[err] warning'))
  log.close()
  assert.ok(existsSync(log.currentPath()!))
})

test('on Windows the launcher ends a hung server the one way there is', () => {
  const log = createServerLog({ logsDir: logsDir() })
  let killed = false
  const process = Object.assign(new EventEmitter(), {
    pid: 7,
    postMessage() {},
    kill() {
      killed = true
      return true
    },
  })
  const child = forkUtilityServer({
    utilityProcess: { fork: () => process } as unknown as UtilityForker,
    modulePath: 'C:\\Program Files\\SprintEngine Studio\\resources\\app.asar\\out\\main\\studio-server.js',
    log,
    killProcess: () => {
      throw new Error('not used on Windows')
    },
    platform: 'win32',
  })
  child.kill()
  assert.equal(killed, true)
  log.close()
})
