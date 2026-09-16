import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { delimiter, join } from 'node:path'
import type { IpcMain } from 'electron'

import { loadMainModules, type CapabilityModule } from './load-modules'
import { createMainKernel } from './main-host'

const INTERPRETER = '/Users/dev/runtime/python/bin/python3'
const MODULE_ROOT = '/Users/dev/modules/weather-deck'

type FakeChild = EventEmitter & {
  stdout: EventEmitter & { setEncoding: (encoding: string) => void }
  stderr: EventEmitter & { setEncoding: (encoding: string) => void }
  pid: number
  killed: boolean
  kill: (signal?: string) => boolean
}

function createFakeIpcMain(): IpcMain {
  return {
    handle: () => undefined,
    removeHandler: () => undefined,
  } as unknown as IpcMain
}

function createFakeChild(pid = 4242): FakeChild {
  const stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined })
  const stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined })
  const child = new EventEmitter() as FakeChild
  child.stdout = stdout
  child.stderr = stderr
  child.pid = pid
  child.killed = false
  child.kill = () => {
    child.killed = true
    setTimeout(() => child.emit('exit', 0, null), 0)
    return true
  }
  return child
}

type RecordedSpawn = {
  command: string
  args: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  child: FakeChild
}

function recordingPython(spawns: RecordedSpawn[]) {
  return {
    resolveInterpreter: () => ({ command: INTERPRETER, source: 'bundled' as const }),
    spawnProcess: ((command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
      const child = createFakeChild(7000 + spawns.length)
      spawns.push({ command, args, cwd: options.cwd, env: options.env, child })
      return child
    }) as unknown as typeof import('node:child_process').spawn,
  }
}

const pythonModule: CapabilityModule = {
  manifest: {
    id: 'weather-deck',
    displayName: 'Weather Deck',
    version: 1,
    defaultEnabled: true,
    source: 'third-party',
    permissions: ['process:spawn'],
  },
  registerMain: () => undefined,
}

async function testEscapingPythonRootIsALoadError(): Promise<void> {
  const escaping: CapabilityModule = {
    ...pythonModule,
    registerMain: (host) => {
      host.registerSidecar({
        id: 'weather-deck-mcp',
        kind: 'python',
        python: { root: '../outside', module: 'weather_deck_mcp' },
        startOn: 'demand',
      })
    },
  }
  const { report } = loadMainModules({
    ipcMain: createFakeIpcMain(),
    modules: [escaping],
    moduleRoots: { 'weather-deck': MODULE_ROOT },
  })
  assert.deepEqual(report.loaded, [])
  assert.equal(report.errors.length, 1)
  assert.equal(report.errors[0]?.id, 'weather-deck')
  assert.match(report.errors[0]?.message ?? '', /must resolve inside the module root/)

  const kernel = createMainKernel(createFakeIpcMain(), {
    resolveModuleRoot: () => MODULE_ROOT,
    resolveModuleManifest: () => pythonModule.manifest,
  })
  assert.throws(
    () =>
      kernel.hostFor('weather-deck').registerSidecar({
        id: 'escapee',
        kind: 'python',
        python: { root: '/etc/passwd', module: 'evil' },
        startOn: 'demand',
      }),
    /must resolve inside the module root/
  )
}

async function testDemandPythonSidecarSpawnsAndDiesOnUnload(): Promise<void> {
  const spawns: RecordedSpawn[] = []
  const kernel = createMainKernel(createFakeIpcMain(), {
    resolveModuleRoot: () => MODULE_ROOT,
    resolveModuleManifest: () => pythonModule.manifest,
    python: recordingPython(spawns),
  })
  const handle = kernel.hostFor('weather-deck').registerSidecar({
    id: 'weather-deck-mcp',
    kind: 'python',
    python: {
      root: 'python',
      module: 'weather_deck_mcp',
      args: ['--http', '--port', '0'],
      env: { WEATHER_DECK_USER_ID: 'studio-app' },
    },
    startOn: 'demand',
  })

  await kernel.runStartup()
  assert.equal(spawns.length, 0, 'demand sidecars do not spawn at startup')
  assert.equal(handle.status().state, 'stopped')

  await handle.start()
  assert.equal(handle.status().state, 'running')
  assert.equal(spawns.length, 1)
  assert.equal(spawns[0]?.command, INTERPRETER)
  assert.deepEqual(spawns[0]?.args, ['-m', 'weather_deck_mcp', '--http', '--port', '0'])
  assert.equal(spawns[0]?.cwd, join(MODULE_ROOT, 'python'))
  const pythonPath = spawns[0]?.env?.PYTHONPATH ?? ''
  assert.equal(pythonPath.split(delimiter)[0], join(MODULE_ROOT, 'python'))
  assert.equal(spawns[0]?.env?.WEATHER_DECK_USER_ID, 'studio-app')
  assert.equal(handle.pid, spawns[0]?.child.pid)
  assert.equal('command' in handle, false, 'the module never sees the interpreter path')

  const child = spawns[0]?.child
  assert.ok(child)
  await kernel.unregisterModule('weather-deck')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(child.killed, true, 'unregisterModule kills the python child')
  assert.equal(handle.status().state, 'stopped')
  assert.equal(kernel.sidecars().length, 0)
}

async function testRunPythonUsesManagedInterpreter(): Promise<void> {
  const spawns: RecordedSpawn[] = []
  const kernel = createMainKernel(createFakeIpcMain(), {
    resolveModuleRoot: () => MODULE_ROOT,
    resolveModuleManifest: () => pythonModule.manifest,
    python: recordingPython(spawns),
  })
  const host = kernel.hostFor('weather-deck')

  const pending = host.runPython({
    root: 'python',
    script: 'scripts/forecast.py',
    args: ['--city', 'Dublin'],
    timeoutMs: 1_000,
  })
  assert.equal(spawns.length, 1)
  assert.equal(spawns[0]?.command, INTERPRETER)
  assert.deepEqual(spawns[0]?.args, [join(MODULE_ROOT, 'python', 'scripts', 'forecast.py'), '--city', 'Dublin'])
  spawns[0]?.child.stdout.emit('data', 'ok\n')
  spawns[0]?.child.emit('close', 0)
  const result = await pending
  assert.deepEqual(result, { exitCode: 0, stdout: 'ok\n', stderr: '' })

  assert.throws(
    () =>
      void host.runPython({
        root: 'python',
        script: '../outside.py',
      }),
    /must resolve inside the module root/
  )
}

function testPythonSidecarRequiresSpawnPermission(): void {
  const kernel = createMainKernel(createFakeIpcMain(), {
    resolveModuleRoot: () => MODULE_ROOT,
    resolveModuleManifest: () => ({
      ...pythonModule.manifest,
      permissions: ['network'],
    }),
  })
  assert.throws(
    () =>
      kernel.hostFor('weather-deck').registerSidecar({
        id: 'weather-deck-mcp',
        kind: 'python',
        python: { root: 'python', module: 'weather_deck_mcp' },
        startOn: 'demand',
      }),
    /process:spawn/
  )
}

function testBundledModuleSkipsSpawnPermission(): void {
  const kernel = createMainKernel(createFakeIpcMain(), {
    resolveModuleRoot: () => MODULE_ROOT,
    resolveModuleManifest: () => ({
      id: 'git',
      displayName: 'Git',
      version: 1,
      defaultEnabled: true,
    }),
  })
  const handle = kernel.hostFor('git').registerSidecar({
    id: 'git-mcp',
    kind: 'python',
    python: { root: 'python', module: 'git_mcp' },
    startOn: 'demand',
  })
  assert.equal(handle.status().state, 'stopped')
}

async function main(): Promise<void> {
  await testEscapingPythonRootIsALoadError()
  await testDemandPythonSidecarSpawnsAndDiesOnUnload()
  await testRunPythonUsesManagedInterpreter()
  testPythonSidecarRequiresSpawnPermission()
  testBundledModuleSkipsSpawnPermission()
  console.log('python-sidecar tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
