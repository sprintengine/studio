import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { PluginManifest } from '../shared/plugin-manifest'
import { STUDIO_MCP_SERVER_ID } from '../shared/product-identity'
import { createMcpConfigService, type PluginLookup } from './mcp-config-service'
import { createPluginRegistry } from './plugin-registry'
import { syncStudioMcpConfig } from './studio-mcp-sync'

// Launches that start together in one checkout sync the same config files at
// once: boot holds every early launch until the gateway is up and then
// releases them all. Each sync reads a file, derives the next content and
// writes it back, so without per-file serialisation and write-then-rename one
// sync reads another's half-written file, takes the empty read for "no
// settings", and writes the person's configuration away.

const ROUNDS = 40
const PARALLEL = 6

function pluginLookup(): PluginLookup {
  const registry = createPluginRegistry({
    bundledRoot: join(process.cwd(), 'resources', 'plugins'),
    userRoot: join(process.cwd(), '.does-not-exist', 'sprintengine', 'plugins'),
  })
  registry.loadSync()
  return (id) => {
    const plugin = registry.get(id)
    return plugin ? { manifest: plugin.manifest as PluginManifest } : undefined
  }
}

const noUserServers = { syncEnabled: false, servers: {} }

async function freshWorkspace(prefix: string): Promise<{ temp: string; root: string }> {
  const temp = await mkdtemp(join(tmpdir(), prefix))
  const root = join(temp, 'workspace')
  await mkdir(join(root, '.claude'), { recursive: true })
  await mkdir(join(root, '.codex'), { recursive: true })
  return { temp, root }
}

async function seedClaudeWorkspace(root: string): Promise<void> {
  await writeFile(
    join(root, '.claude', 'settings.local.json'),
    `${JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }, null, 2)}\n`,
  )
  // A stale gateway entry from an earlier build, so every sync has something to write.
  await writeFile(
    join(root, '.mcp.json'),
    `${JSON.stringify(
      {
        mcpServers: {
          other: { command: 'other-server', args: [] },
          [STUDIO_MCP_SERVER_ID]: { command: '/old/path', args: [] },
        },
      },
      null,
      2,
    )}\n`,
  )
}

async function assertNoTemporaries(directory: string): Promise<void> {
  const leftovers = (await readdir(directory)).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], `no temporary file is left in ${directory}`)
}

test('parallel Claude syncs keep the person’s settings and .mcp.json servers', async () => {
  const lookupPlugin = pluginLookup()
  for (let round = 0; round < ROUNDS; round++) {
    const { temp, root } = await freshWorkspace('sprintengine-mcp-race-claude-')
    await seedClaudeWorkspace(root)
    const service = createMcpConfigService({
      lookupPlugin,
      homeDir: () => temp,
      userDataDir: () => join(temp, 'user-data'),
    })
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        syncStudioMcpConfig(
          { workspaceRoot: root, settings: noUserServers, clients: ['claude-code'] },
          {
            mcpConfigService: service,
            studioGateway: () => ({ command: process.execPath, args: ['/new/bridge.js'], env: {} }),
          },
        ),
      ),
    )
    for (const result of results) assert.equal(result.ok, true, result.ok ? '' : `round ${round}: ${result.message}`)

    const settings = JSON.parse(await readFile(join(root, '.claude', 'settings.local.json'), 'utf8'))
    assert.deepEqual(settings.permissions, { allow: ['Bash(npm test)'] }, `round ${round}: permissions survive`)
    assert.deepEqual(settings.enabledMcpjsonServers, [STUDIO_MCP_SERVER_ID], `round ${round}: gateway approved once`)
    const mcpJson = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8'))
    assert.ok(mcpJson.mcpServers.other, `round ${round}: the person's own server survives`)
    assert.deepEqual(mcpJson.mcpServers[STUDIO_MCP_SERVER_ID].args, ['/new/bridge.js'])
    await assertNoTemporaries(root)
    await assertNoTemporaries(join(root, '.claude'))
  }
})

test('parallel Codex syncs keep the rest of config.toml', async () => {
  const lookupPlugin = pluginLookup()
  const userConfig = 'model = "gpt-5"\n\n[profiles.fast]\nmodel = "gpt-5-mini"\n'
  const staleBlock = [
    '# >>> sprintengine mcp managed',
    `[mcp_servers.${STUDIO_MCP_SERVER_ID}]`,
    'command = "/old/path"',
    '# <<< sprintengine mcp managed',
  ].join('\n')
  for (let round = 0; round < ROUNDS; round++) {
    const { temp, root } = await freshWorkspace('sprintengine-mcp-race-codex-')
    await writeFile(join(root, '.codex', 'config.toml'), `${userConfig}\n${staleBlock}\n`)
    const service = createMcpConfigService({
      lookupPlugin,
      homeDir: () => temp,
      userDataDir: () => join(temp, 'user-data'),
    })
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        syncStudioMcpConfig(
          { workspaceRoot: root, settings: noUserServers, clients: ['codex'] },
          {
            mcpConfigService: service,
            studioGateway: () => ({ command: process.execPath, args: ['/new/bridge.js'], env: {} }),
          },
        ),
      ),
    )
    for (const result of results) assert.equal(result.ok, true, result.ok ? '' : `round ${round}: ${result.message}`)
    const toml = await readFile(join(root, '.codex', 'config.toml'), 'utf8')
    assert.ok(toml.startsWith(userConfig.trimEnd()), `round ${round}: the person's config survives:\n${toml}`)
    assert.equal(toml.split('# >>> sprintengine mcp managed').length, 2, `round ${round}: one managed block`)
    assert.match(toml, /\/new\/bridge\.js/)
    await assertNoTemporaries(join(root, '.codex'))
  }
})

test('a gateway removal racing a gateway sync never loses the person’s settings', async () => {
  const lookupPlugin = pluginLookup()
  for (let round = 0; round < ROUNDS; round++) {
    const { temp, root } = await freshWorkspace('sprintengine-mcp-race-mixed-')
    await seedClaudeWorkspace(root)
    const service = createMcpConfigService({
      lookupPlugin,
      homeDir: () => temp,
      userDataDir: () => join(temp, 'user-data'),
    })
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, (_, index) =>
        syncStudioMcpConfig(
          {
            workspaceRoot: root,
            settings: noUserServers,
            clients: ['claude-code'],
            studioGatewayDeliveredAtLaunch: index % 2 === 0,
          },
          {
            mcpConfigService: service,
            studioGateway: () => ({ command: process.execPath, args: ['/new/bridge.js'], env: {} }),
          },
        ),
      ),
    )
    for (const result of results) assert.equal(result.ok, true, result.ok ? '' : `round ${round}: ${result.message}`)
    const settings = JSON.parse(await readFile(join(root, '.claude', 'settings.local.json'), 'utf8'))
    assert.deepEqual(settings.permissions, { allow: ['Bash(npm test)'] }, `round ${round}: permissions survive`)
    const mcpJson = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8'))
    assert.ok(mcpJson.mcpServers.other, `round ${round}: the person's own server survives`)
  }
})

test('an unparsable settings.local.json is reported and left exactly as it was', async () => {
  const { temp, root } = await freshWorkspace('sprintengine-mcp-unparsable-')
  const broken = '{ "permissions": { "allow": ["Bash(npm test)"] ,\n'
  await writeFile(join(root, '.claude', 'settings.local.json'), broken)
  const service = createMcpConfigService({
    lookupPlugin: pluginLookup(),
    homeDir: () => temp,
    userDataDir: () => join(temp, 'user-data'),
  })
  const result = await syncStudioMcpConfig(
    { workspaceRoot: root, settings: noUserServers, clients: ['claude-code'] },
    {
      mcpConfigService: service,
      studioGateway: () => ({ command: process.execPath, args: ['/new/bridge.js'], env: {} }),
    },
  )
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.message, /settings\.local\.json is not valid JSON/)
  assert.equal(await readFile(join(root, '.claude', 'settings.local.json'), 'utf8'), broken)
})

test('an unparsable .mcp.json is reported and left exactly as it was', async () => {
  const { temp, root } = await freshWorkspace('sprintengine-mcp-unparsable-')
  const broken = '{ "mcpServers": { "other": '
  await writeFile(join(root, '.mcp.json'), broken)
  const service = createMcpConfigService({
    lookupPlugin: pluginLookup(),
    homeDir: () => temp,
    userDataDir: () => join(temp, 'user-data'),
  })
  const result = await syncStudioMcpConfig(
    { workspaceRoot: root, settings: noUserServers, clients: ['claude-code'] },
    {
      mcpConfigService: service,
      studioGateway: () => ({ command: process.execPath, args: ['/new/bridge.js'], env: {} }),
    },
  )
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.message, /\.mcp\.json is not valid JSON/)
  assert.equal(await readFile(join(root, '.mcp.json'), 'utf8'), broken)
})

test('a rewrite keeps the file’s permission bits and writes through a symlink', async () => {
  const { temp, root } = await freshWorkspace('sprintengine-mcp-mode-')
  await seedClaudeWorkspace(root)
  const shared = join(temp, 'shared-settings.json')
  await rename(join(root, '.claude', 'settings.local.json'), shared)
  await symlink(shared, join(root, '.claude', 'settings.local.json'))
  await chmod(shared, 0o600)
  await chmod(join(root, '.mcp.json'), 0o640)
  const service = createMcpConfigService({
    lookupPlugin: pluginLookup(),
    homeDir: () => temp,
    userDataDir: () => join(temp, 'user-data'),
  })
  const result = await syncStudioMcpConfig(
    { workspaceRoot: root, settings: noUserServers, clients: ['claude-code'] },
    {
      mcpConfigService: service,
      studioGateway: () => ({ command: process.execPath, args: ['/new/bridge.js'], env: {} }),
    },
  )
  assert.equal(result.ok, true, result.ok ? '' : result.message)
  assert.equal((await stat(join(root, '.mcp.json'))).mode & 0o777, 0o640)
  assert.ok((await lstat(join(root, '.claude', 'settings.local.json'))).isSymbolicLink(), 'the link is kept')
  assert.equal((await stat(shared)).mode & 0o777, 0o600)
  const settings = JSON.parse(await readFile(shared, 'utf8'))
  assert.deepEqual(settings.enabledMcpjsonServers, [STUDIO_MCP_SERVER_ID], 'written through to the target')
})
