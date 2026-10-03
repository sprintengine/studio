import { expect, test } from 'vitest'
import { cliSpawnTarget, terminateCliChild } from './cli-child-process'

const shim = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd'

test('a batch shim on Windows runs through the command processor with every argument quoted', () => {
  expect(cliSpawnTarget(shim, ['app-server', '--listen', 'stdio://'], { platform: 'win32', env: {} })).toEqual({
    file: 'cmd.exe',
    args: ['/d', '/s', '/c', `""${shim}" "app-server" "--listen" "stdio://""`],
    windowsVerbatimArguments: true,
  })
  expect(
    cliSpawnTarget('C:\\Program Files\\agent\\agent.BAT', ['acp'], {
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    }).file,
  ).toBe('C:\\Windows\\System32\\cmd.exe')
})

test('a batch shim argument the command processor would reinterpret is refused', () => {
  expect(() => cliSpawnTarget(shim, ['%PATH%'], { platform: 'win32', env: {} })).toThrow('Cannot start')
  expect(() => cliSpawnTarget('C:\\Users\\dev\\"odd"\\codex.cmd', [], { platform: 'win32', env: {} })).toThrow(
    'Cannot start',
  )
})

test('in a folder inside a distribution a batch shim gives way to its PowerShell twin', () => {
  const cwd = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'
  const twin = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.ps1'
  const seen: string[] = []
  const exists = (path: string) => (seen.push(path), path === twin)
  expect(cliSpawnTarget(shim, ['app-server'], { platform: 'win32', env: {}, cwd, exists })).toEqual({
    file: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', twin, 'app-server'],
  })
  expect(seen).toEqual([twin])
  expect(() =>
    cliSpawnTarget('C:\\tools\\agent.bat', ['acp'], { platform: 'win32', env: {}, cwd, exists: () => false }),
  ).toThrow('cannot start one in')
  expect(cliSpawnTarget(shim, ['app-server'], { platform: 'win32', env: {}, cwd: 'C:\\Users\\dev\\repo' }).file).toBe(
    'cmd.exe',
  )
  expect(cliSpawnTarget('C:\\tools\\grok.exe', ['stdio'], { platform: 'win32', cwd }).file).toBe('C:\\tools\\grok.exe')
})

test('a PowerShell shim runs through PowerShell and executables are spawned directly', () => {
  expect(cliSpawnTarget('C:\\Users\\dev\\AppData\\Roaming\\npm\\opencode.ps1', ['acp'], { platform: 'win32' })).toEqual(
    {
      file: 'powershell.exe',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        'C:\\Users\\dev\\AppData\\Roaming\\npm\\opencode.ps1',
        'acp',
      ],
    },
  )
  expect(cliSpawnTarget('C:\\tools\\grok.exe', ['stdio'], { platform: 'win32' })).toEqual({
    file: 'C:\\tools\\grok.exe',
    args: ['stdio'],
  })
  expect(cliSpawnTarget('/Users/dev/bin/codex.cmd', ['app-server'], { platform: 'darwin' })).toEqual({
    file: '/Users/dev/bin/codex.cmd',
    args: ['app-server'],
  })
})

test('stopping a CLI child ends its whole tree on Windows and escalates elsewhere', () => {
  const signals: unknown[] = []
  const child = { pid: 4242, exitCode: null, kill: (signal?: unknown) => signals.push(signal) > 0 }
  const killed: number[] = []
  terminateCliChild(child, { platform: 'win32', runTaskkill: (pid) => killed.push(pid) })
  expect(killed).toEqual([4242])
  expect(signals).toEqual([])
  terminateCliChild(child, { platform: 'darwin' })
  expect(signals).toEqual(['SIGTERM'])
  terminateCliChild({ ...child, exitCode: 0 }, { platform: 'win32', runTaskkill: (pid) => killed.push(pid) })
  expect(killed).toEqual([4242])
})
