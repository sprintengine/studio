import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { PluginAgentStateSpec } from '../shared/plugin-manifest'
import { createAgentStateService } from './agent-state-service'
import type { RunOutcome } from './process-run'
import { createWslHomeProbe } from './wsl-home'

const UBUNTU_OUTPUT = [
  'Welcome to Ubuntu',
  'SPRINTENGINE_WSL_HOME=\\\\wsl.localhost\\Ubuntu\\home\\dev',
  'SPRINTENGINE_WSL_ROOT=\\\\wsl.localhost\\Ubuntu\\',
  '',
].join('\r\n')

function ok(stdout: string): RunOutcome {
  return { code: 0, stdout, stderr: '', timedOut: false }
}

test('the WSL home is asked in the named distribution, by a login shell on stdin, and kept a while', async () => {
  const runs: Array<{ distro: string | null; script: string }> = []
  let now = 0
  const probe = createWslHomeProbe({
    run: async (distro, script) => {
      runs.push({ distro, script })
      return ok(UBUNTU_OUTPUT.replaceAll('Ubuntu', distro ?? 'Ubuntu'))
    },
    resolveDefaultDistro: async () => 'Ubuntu',
    now: () => now,
  })
  assert.equal((await probe())?.home, '\\\\wsl.localhost\\Ubuntu\\home\\dev')
  assert.equal((await probe('Debian'))?.home, '\\\\wsl.localhost\\Debian\\home\\dev')
  assert.equal((await probe('Ubuntu'))?.home, '\\\\wsl.localhost\\Ubuntu\\home\\dev')
  assert.deepEqual(
    runs.map((run) => run.distro),
    ['Ubuntu', 'Debian'],
    'the default is resolved to its name, and each distribution is asked once',
  )
  assert.match(runs[0].script, /^exec bash -l <</u)
  assert.match(runs[0].script, /wslpath -w/u)
  now += 61_000
  await probe()
  assert.equal(runs.length, 3, 'asked again once the answer is a minute old')
})

test('a failed WSL home probe is not kept', async () => {
  let answer: RunOutcome = { code: 1, stdout: '', stderr: 'wsl: error', timedOut: false }
  let runs = 0
  const probe = createWslHomeProbe({
    run: async () => {
      runs += 1
      return answer
    },
    resolveDefaultDistro: async () => null,
  })
  assert.equal(await probe(), null)
  answer = ok(UBUNTU_OUTPUT)
  assert.equal((await probe())?.home, '\\\\wsl.localhost\\Ubuntu\\home\\dev')
  assert.equal(runs, 2)
})

// Kimi's hook config is user-global. Run through WSL, the Kimi that reads it is
// a Linux process, so the file belongs in the distribution's home. A temp dir
// stands in for `\\wsl.localhost\Ubuntu\home\dev`.
test('a WSL launch installs a user-scoped hook into the Linux home, a native one into the Windows home', async () => {
  const manifest = JSON.parse(
    await readFile(join(process.cwd(), 'resources', 'plugins', 'kimi-code', 'plugin.json'), 'utf8'),
  ) as { agentStateSpec: PluginAgentStateSpec }
  const windowsHome = await mkdtemp(join(tmpdir(), 'se-kimi-windows-home-'))
  const wslHome = await mkdtemp(join(tmpdir(), 'se-kimi-wsl-home-'))
  const workspace = await mkdtemp(join(tmpdir(), 'se-kimi-ws-'))
  const userData = await mkdtemp(join(tmpdir(), 'se-kimi-ud-'))
  const reporter = join(userData, 'agent-state.mjs')
  await writeFile(reporter, '// reporter\n', 'utf8')
  let wslHomeAnswer: string | null = null
  const asked: string[] = []
  const service = createAgentStateService({
    resolveUserDataDir: () => userData,
    resolveAgentStateSpec: (cli) => (cli === 'kimi-code' ? manifest.agentStateSpec : null),
    resolveReporterScriptPath: () => reporter,
    resolveReporterTemplatePath: () => null,
    resolveHomeDir: () => windowsHome,
    resolveHostNodeCommand: () => 'C:\\Program Files\\SprintEngine Studio\\SprintEngine Studio.exe',
    resolveWslHomeDir: async (root) => {
      asked.push(root)
      return wslHomeAnswer
    },
    onFrame: () => {},
  })

  // The distribution could not be asked: nothing is written anywhere.
  await service.installForWorkspace(workspace, 'kimi-code', { pathStyle: 'wsl' })
  assert.deepEqual(asked, [workspace])
  assert.equal(existsSync(join(wslHome, '.kimi-code', 'config.toml')), false)
  assert.equal(existsSync(join(windowsHome, '.kimi-code', 'config.toml')), false)

  // Next launch it answers: the config and the reporter copy land in Linux.
  wslHomeAnswer = wslHome
  await service.installForWorkspace(workspace, 'kimi-code', { pathStyle: 'wsl' })
  const config = await readFile(join(wslHome, '.kimi-code', 'config.toml'), 'utf8')
  assert.ok(config.includes('event = "Stop"'), config)
  assert.ok(config.includes('SprintEngine Studio.exe'), 'the hook calls back through interop, as for any WSL hook')
  assert.equal(existsSync(join(wslHome, '.sprintengine', 'hooks', 'agent-state.mjs')), true)
  assert.equal(existsSync(join(windowsHome, '.kimi-code', 'config.toml')), false)

  // Run natively, the same CLI's config is the Windows one.
  await service.installForWorkspace(workspace, 'kimi-code', { pathStyle: 'windows' })
  assert.equal(existsSync(join(windowsHome, '.kimi-code', 'config.toml')), true)
})
