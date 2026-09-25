// Taking Studio's integrations back out. Every fixture is a temporary home and
// repository with the person's own content around what Studio wrote; tailnet
// state is a stand-in, never the real `tailscale`.

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { installAgentStateReporter } from '../agent-state'
import { agentWorktreeLockReason, lockAgentWorktree, setAgentWorktreeLockProfile } from '../agent-worktree-lock'
import { runGitCommand } from '../git-utils'
import type { PluginAgentStateSpec } from '../../shared/plugin-manifest'
import { createIntegrationLedger, installIntegrationLedger, type IntegrationWrite } from './ledger'
import { runRemovalCommand } from './remove-integrations-cli'
import { planIntegrationRemoval, removeIntegrations, type IntegrationRemovalDeps } from './remove-integrations'
import { ensureStudioLauncher, launcherRefForHome } from './launcher'
import { excludeFromWorktree } from './worktree-exclude'

afterEach(() => {
  installIntegrationLedger(null)
  setAgentWorktreeLockProfile(null)
})

const RESOURCES = join(process.cwd(), 'resources')
const SOCKET = '/Users/dev/Library/Application Support/SprintEngine Studio/agent-state.sock'

async function spec(id: string): Promise<PluginAgentStateSpec> {
  return (
    JSON.parse(await readFile(join(RESOURCES, 'plugins', id, 'plugin.json'), 'utf8')) as {
      agentStateSpec: PluginAgentStateSpec
    }
  ).agentStateSpec
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runGitCommand(cwd, args)
  assert.ok(result.ok, `git ${args.join(' ')}: ${result.message ?? ''}`)
  return result.stdout
}

async function write(path: string, content: string | object): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`)
}

const PERSONS_CODEX = 'model = "gpt-5-codex"\n\n[mcp_servers.theirs]\ncommand = "npx"\n'
const PERSONS_KIMI = 'default_model = "k2"\n'

/**
 * A world as this build leaves it: the ledger recording each write as it
 * happens, the launcher in the home, and the person's own content everywhere
 * Studio wrote.
 */
async function world() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-remove-')))
  const home = join(root, 'home')
  const repo = join(root, 'repo')
  const userData = join(root, 'userData')
  await mkdir(repo, { recursive: true })
  await git(repo, 'init', '-q')
  await git(repo, 'config', 'core.excludesFile', join(root, 'no-global-excludes'))
  await write(join(repo, 'README.md'), '# app\n')
  await git(repo, 'add', 'README.md')
  await git(repo, '-c', 'user.email=dev@example.com', '-c', 'user.name=dev', 'commit', '-q', '-m', 'seed')

  const ledger = createIntegrationLedger({ path: join(userData, 'integration-ledger.json') })
  installIntegrationLedger(ledger)
  await ensureStudioLauncher({
    nativeHome: home,
    shell: 'posix',
    pointer: { node: process.execPath, runAsNode: false, payload: RESOURCES, packaged: false },
  })
  await ledger.record([
    { kind: 'launcher', path: join(home, '.sprintengine', 'bin'), marker: 'owned', hostId: 'local', createdFile: true },
  ])

  // The person's own content first.
  await write(join(repo, '.codex', 'config.toml'), PERSONS_CODEX)
  await write(join(repo, '.claude', 'settings.local.json'), { permissions: { allow: ['Bash(ls:*)'] } })
  await write(join(repo, '.mcp.json'), { mcpServers: { theirs: { command: 'npx', args: ['theirs'] } } })
  await write(join(home, '.kimi-code', 'config.toml'), PERSONS_KIMI)

  // Then Studio's, through the real writers.
  for (const [id, workspace] of [
    ['claude-code', repo],
    ['codex', repo],
    ['cursor', repo],
    ['grok', repo],
    ['kimi-code', repo],
  ] as const) {
    const result = await installAgentStateReporter(workspace, await spec(id), {
      sourceScriptPath: join(RESOURCES, 'hooks', 'sprintengine-agent-state.mjs'),
      statusLineScriptPath: join(RESOURCES, 'hooks', 'sprintengine-status-line.mjs'),
      socketPath: SOCKET,
      homeDir: home,
      env: {},
      cli: id,
    })
    assert.ok(result.ok, JSON.stringify(result))
  }
  // The gateway, as the MCP writer leaves it.
  const gateway = { type: 'stdio', command: '/bin/sh', args: [launcherRefForHome(home, 'posix').path, 'mcp'] }
  const mcp = JSON.parse(await readFile(join(repo, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> }
  mcp.mcpServers['sprintengine-studio'] = gateway
  await write(join(repo, '.mcp.json'), mcp)
  await ledger.record([
    {
      kind: 'mcp-gateway',
      path: join(repo, '.mcp.json'),
      marker: 'mcpServers.sprintengine-studio',
      hostId: 'local',
      repo,
      createdFile: false,
    },
  ])
  await ledger.flush()
  return { root, home, repo, userData, ledger }
}

function deps(
  ledger: ReturnType<typeof createIntegrationLedger>,
  extra: Partial<IntegrationRemovalDeps> = {},
): IntegrationRemovalDeps {
  return { ledger, env: {}, ...extra }
}

test("removal takes out only what Studio wrote, leaving the person's content byte for byte", async () => {
  const { home, repo, ledger } = await world()

  const plan = await planIntegrationRemoval(deps(ledger))
  const groups = new Set(plan.items.map((item) => item.group))
  assert.ok(groups.has('repositories') && groups.has('launcher'), [...groups].join(','))
  assert.equal(plan.items.at(-1)?.group, 'launcher', 'the launcher goes last: everything above runs it')

  const report = await removeIntegrations(deps(ledger))
  assert.equal(report.failed, 0, JSON.stringify(report.outcomes.filter((outcome) => outcome.status === 'failed')))

  assert.equal(await readFile(join(repo, '.codex', 'config.toml'), 'utf8'), PERSONS_CODEX)
  assert.equal(await readFile(join(home, '.kimi-code', 'config.toml'), 'utf8'), PERSONS_KIMI)
  assert.deepEqual(JSON.parse(await readFile(join(repo, '.claude', 'settings.local.json'), 'utf8')), {
    permissions: { allow: ['Bash(ls:*)'] },
  })
  assert.deepEqual(JSON.parse(await readFile(join(repo, '.mcp.json'), 'utf8')), {
    mcpServers: { theirs: { command: 'npx', args: ['theirs'] } },
  })
  // Files Studio created and nothing else lives in are gone.
  assert.equal(existsSync(join(repo, '.cursor', 'hooks.json')), false)
  assert.equal(existsSync(join(repo, '.grok')), false)
  // The launcher, and `~/.sprintengine` once empty.
  assert.equal(existsSync(join(home, '.sprintengine')), false)
  assert.deepEqual(await ledger.list(), [], 'everything removed is off the list')

  // Idempotent: a second run finds nothing, and fails nothing.
  const again = await removeIntegrations(deps(ledger))
  assert.deepEqual([again.removed, again.failed], [0, 0])
  assert.equal(await readFile(join(repo, '.codex', 'config.toml'), 'utf8'), PERSONS_CODEX)
})

test('a file Studio created is deleted when emptied, unless git tracks it', async () => {
  const { repo, ledger } = await world()
  const tracked = join(repo, 'opencode.json')
  const gateway = { type: 'local', command: ['/bin/sh', '/Users/dev/.sprintengine/bin/studio-run', 'mcp'] }
  await write(tracked, { mcp: { 'sprintengine-studio': gateway } })
  await git(repo, 'add', 'opencode.json')
  await git(
    repo,
    '-c',
    'user.email=dev@example.com',
    '-c',
    'user.name=dev',
    'commit',
    '-q',
    '-m',
    'committed by mistake',
  )
  const untracked = join(repo, '.cursor', 'mcp.json')
  await write(untracked, {
    mcpServers: { 'sprintengine-studio': { command: '/bin/sh', args: gateway.command.slice(1) } },
  })
  const base = { hostId: 'local', repo, createdFile: true } as const
  await ledger.record([
    { kind: 'mcp-gateway', path: tracked, marker: 'mcp.sprintengine-studio', ...base },
    { kind: 'mcp-gateway', path: untracked, marker: 'mcpServers.sprintengine-studio', ...base },
  ] satisfies IntegrationWrite[])

  await removeIntegrations(deps(ledger))
  assert.deepEqual(JSON.parse(await readFile(tracked, 'utf8')), {}, 'a tracked file is emptied, not deleted')
  assert.equal(existsSync(untracked), false)
})

test('only the tailnet ports Studio published, still pointing where it pointed, are taken down', async () => {
  const { ledger } = await world()
  await ledger.record([
    {
      kind: 'tailnet-share',
      path: 'tailscale-serve:https:8443',
      marker: 'x',
      hostId: 'local',
      detail: { servePort: 8443, localPort: 5173 },
    },
    {
      kind: 'tailnet-share',
      path: 'tailscale-serve:https:10000',
      marker: 'y',
      hostId: 'local',
      detail: { servePort: 10000, localPort: 3000 },
    },
  ])
  // 8443 is still ours; 10000 was re-pointed by hand; 443 was never ours.
  const served = new Map([
    [8443, 5173],
    [10000, 4000],
    [443, 8471],
  ])
  const unshared: number[] = []
  const report = await removeIntegrations(
    deps(ledger, {
      readServedPorts: async () => served,
      unsharePort: async (port) => {
        unshared.push(port)
        return { ok: true }
      },
    }),
  )
  assert.deepEqual(unshared, [8443])
  assert.equal(report.outcomes.find((outcome) => outcome.path.endsWith(':10000'))?.status, 'skipped')
})

test("a worktree lock is released only when it is this profile's, and the worktree is kept", async () => {
  const { root, repo, ledger } = await world()
  setAgentWorktreeLockProfile(join(root, 'userData'))
  const ours = join(root, 'wt-ours')
  const theirs = join(root, 'wt-theirs')
  await git(repo, 'worktree', 'add', '-q', '-b', 'ours', ours)
  await git(repo, 'worktree', 'add', '-q', '-b', 'theirs', theirs)
  assert.ok((await lockAgentWorktree(repo, ours, 'agent-1')).ok)
  await git(repo, 'worktree', 'lock', '--reason', 'kept by hand', theirs)
  await ledger.flush()
  await ledger.record([
    { kind: 'worktree-lock', path: theirs, marker: agentWorktreeLockReason('x'), hostId: 'local', repo },
  ])

  await removeIntegrations(deps(ledger))
  const listing = await git(repo, 'worktree', 'list', '--porcelain')
  const block = (path: string) => listing.split('\n\n').find((chunk) => chunk.includes(`worktree ${path}`)) ?? ''
  assert.ok(!block(ours).includes('locked'), 'our lock is released')
  assert.ok(block(theirs).includes('locked kept by hand'), "a person's lock stays")
  assert.ok(existsSync(ours), 'the worktree itself stays')
})

test('the per-worktree excludes come out, and worktreeConfig goes back off when the app turned it on', async () => {
  const { root, repo, ledger } = await world()
  const wt = join(root, 'wt')
  await git(repo, 'worktree', 'add', '-q', '-b', 'wt', wt)
  await excludeFromWorktree(wt, ['.mcp.json'])
  await ledger.flush()
  await removeIntegrations(deps(ledger))
  const config = await runGitCommand(repo, ['config', '--get', 'extensions.worktreeConfig'])
  assert.equal(config.ok, false, 'turned back off')
  const excludes = await runGitCommand(wt, ['config', '--worktree', '--get', 'core.excludesFile'])
  assert.equal(excludes.ok, false)
})

test('one distribution is cleaned on its own', async () => {
  const { root, ledger } = await world()
  const distroHome = join(root, 'distro-home')
  const data = join(distroHome, '.local', 'share', 'sprintengine-studio')
  await write(join(data, '0.4.0', 'hooks', 'x.mjs'), '')
  await ledger.record([{ kind: 'wsl-data', path: data, marker: 'owned', hostId: 'wsl:Ubuntu', createdFile: true }])
  const plan = await planIntegrationRemoval(deps(ledger), { hostId: 'wsl:Ubuntu' })
  assert.deepEqual(
    plan.items.map((item) => [item.group, item.hostId]),
    [['wsl', 'wsl:Ubuntu']],
  )
  assert.deepEqual(plan.appDataPaths, [], 'app data is never offered for one machine')
  const report = await removeIntegrations(deps(ledger), { hostId: 'wsl:Ubuntu' })
  assert.equal(report.removed, 1)
  assert.equal(existsSync(data), false)
  assert.ok(
    (await ledger.list()).some((entry) => entry.kind === 'launcher'),
    "this machine's entries are untouched",
  )
})

test('the command line exits 0 when everything went, 2 when something failed, 3 when it could not run', async () => {
  const { home, userData, ledger } = await world()
  const lines: string[] = []
  await ledger.record([
    {
      kind: 'tailnet-share',
      path: 'tailscale-serve:https:8443',
      marker: 'x',
      hostId: 'local',
      detail: { servePort: 8443, localPort: 5173 },
    },
  ])
  const failing = await runRemovalCommand({
    userDataDir: userData,
    home,
    deps: {
      readServedPorts: async () => new Map([[8443, 5173]]),
      unsharePort: async () => ({ ok: false, message: 'Tailscale refused the change.' }),
    },
    write: (text) => lines.push(text),
  })
  assert.equal(failing, 2)
  assert.ok(lines.join('').includes('summary\tremoved='))
  assert.ok(existsSync(join(userData, 'integration-removal.log')))

  const ok = await runRemovalCommand({
    userDataDir: userData,
    home,
    deps: { readServedPorts: async () => new Map(), unsharePort: async () => ({ ok: true }) },
    write: () => undefined,
  })
  assert.equal(ok, 0)

  const broken = await runRemovalCommand({
    userDataDir: join(userData, 'integration-ledger.json', 'not-a-dir'),
    home,
    deps: { listRoots: () => Promise.reject(new Error('no registry')) },
    write: () => undefined,
  })
  assert.equal(broken, 3)
})

test('a ledger path of the wrong shape is never deleted, and only the launcher’s own files leave its folder', async () => {
  const { root, home, ledger } = await world()
  // A garbled entry naming a folder full of the person's dotfiles.
  const dotfiles = join(root, 'person')
  await write(join(dotfiles, '.zshrc'), 'export A=1\n')
  await write(join(dotfiles, 'agent-state.mjs'), '// theirs\n')
  await write(join(home, '.sprintengine', 'bin', '.bashrc'), 'theirs\n')
  await ledger.record([
    { kind: 'launcher', path: dotfiles, marker: 'owned', hostId: 'local' },
    { kind: 'hook-script', path: join(dotfiles, 'agent-state.mjs'), marker: 'owned', hostId: 'local' },
    { kind: 'studio-plugin-copy', path: dotfiles, marker: 'owned', hostId: 'local' },
    { kind: 'wsl-data', path: dotfiles, marker: 'owned', hostId: 'local' },
  ])
  await removeIntegrations(deps(ledger))
  assert.equal(await readFile(join(dotfiles, '.zshrc'), 'utf8'), 'export A=1\n')
  assert.ok(existsSync(join(dotfiles, 'agent-state.mjs')))
  assert.ok(existsSync(join(home, '.sprintengine', 'bin', '.bashrc')), 'a file of theirs in the launcher folder stays')
  assert.ok(!existsSync(join(home, '.sprintengine', 'bin', 'studio-run')), 'while the launcher itself goes')
})

test('an unreachable Tailscale fails the share rather than forgetting it', async () => {
  const { ledger } = await world()
  await ledger.record([
    {
      kind: 'tailnet-share',
      path: 'tailscale-serve:https:8443',
      marker: 'x',
      hostId: 'local',
      detail: { servePort: 8443, localPort: 5173 },
    },
  ])
  const report = await removeIntegrations(
    deps(ledger, { readServedPorts: async () => null, unsharePort: async () => ({ ok: true }) }),
  )
  assert.equal(report.outcomes.find((outcome) => outcome.path.endsWith(':8443'))?.status, 'failed')
  assert.ok(
    (await ledger.list()).some((entry) => entry.kind === 'tailnet-share'),
    'still listed for the next run',
  )
  // A share does not run the launcher, so its failing does not keep the launcher.
  assert.ok(!(await ledger.list()).some((entry) => entry.kind === 'launcher'))
})

test('a copy the repository committed is left for the project', async () => {
  const { repo, ledger } = await world()
  const skill = join(repo, '.agents', 'skills', 'studio-backlog')
  await write(join(skill, 'SKILL.md'), '# skill\n')
  await write(join(skill, '.sprintengine-skill.json'), { sourceId: 'sprintengine-studio', skillId: 'studio-backlog' })
  await git(repo, 'add', '.agents')
  await git(repo, '-c', 'user.email=dev@example.com', '-c', 'user.name=dev', 'commit', '-q', '-m', 'vendored')
  await ledger.record([
    { kind: 'skill-copy', path: skill, marker: 'provenance:sprintengine-studio', hostId: 'local', repo },
  ])
  const report = await removeIntegrations(deps(ledger))
  assert.ok(existsSync(join(skill, 'SKILL.md')))
  assert.match(report.outcomes.find((outcome) => outcome.path === skill)?.reason ?? '', /committed/u)
})

test('asked to, a clean locked worktree is removed and one with changes is kept, both unlocked', async () => {
  const { root, repo, ledger } = await world()
  setAgentWorktreeLockProfile(join(root, 'userData'))
  const clean = join(root, 'wt-clean')
  const dirty = join(root, 'wt-dirty')
  await git(repo, 'worktree', 'add', '-q', '-b', 'clean', clean)
  await git(repo, 'worktree', 'add', '-q', '-b', 'dirty', dirty)
  await lockAgentWorktree(repo, clean, 'agent-1')
  await lockAgentWorktree(repo, dirty, 'agent-2')
  await write(join(dirty, 'notes.txt'), 'work in progress\n')
  await ledger.flush()
  const report = await removeIntegrations(deps(ledger), { removeWorktrees: true })
  assert.equal(existsSync(clean), false)
  assert.equal(existsSync(join(dirty, 'notes.txt')), true)
  assert.match(report.outcomes.find((outcome) => outcome.path === dirty)?.reason ?? '', /Unlocked, and kept/u)
})
