import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { registerSprintEngineIpc } from './ipc/sprintengine-ipc'
import { createPluginRegistry } from './plugin-registry'
import { __resetPluginRegistryForTest, __setPluginRegistryForTest } from './plugin-registry-instance'
import { createSprintEngineArtifactHandlers } from './sprintengine-artifacts'

type IpcHandler = (_event: unknown, payload: unknown) => Promise<unknown>

async function main(): Promise<void> {
  await testReadProjectionUsesProjectionFile()
  await testReadProjectionSurfacesUnavailableAndInvalidProjection()
  await testReadRegistryRolesUsesMcpTool()
  await testReadRegistryRolesPassesLoadedPluginSoulsRoots()
  await testReadRegistryRolesUsesRealMcpBridgeForBundledAndCustomRoles()
  await testReadRegistryRoleSurfacesUnknownRole()
  await testReadDispatchUsesMcpTool()
  await testReadBridgeSurfacesUnavailableMcpAndMalformedPayloads()
  await testIpcRegistersReadOnlyBridgeChannels()

  console.log('sprintengine-artifacts tests passed')
}

async function createStateFixture(): Promise<{ workspaceRoot: string; teamDir: string; statePath: string }> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-sprintengine-bridge-'))
  const teamDir = join(workspaceRoot, '.multi-code', 'sprintengine', 'team')
  await mkdir(teamDir, { recursive: true })
  const statePath = join(teamDir, 'run.yaml')
  await writeFile(statePath, 'name: Bridge Test\n', 'utf-8')
  await writeFile(
    join(teamDir, 'projection.json'),
    JSON.stringify({
      tasks: [],
      agents: {
        'developer-1': {
          role: 'developer',
          currentDispatch: { dispatchId: 'DISP-1', taskId: 'T1' },
        },
      },
    }),
    'utf-8'
  )
  return { workspaceRoot, teamDir, statePath }
}

function createHandlers(runMcpTool: Parameters<typeof createSprintEngineArtifactHandlers>[0]['runMcpTool']) {
  return createSprintEngineArtifactHandlers({
    getAuthenticatedUserId: () => 'user-1',
    openExternal: async () => undefined,
    runMcpTool,
  })
}

async function testReadProjectionUsesProjectionFile(): Promise<void> {
  const { statePath } = await createStateFixture()
  const handlers = createHandlers(async () => {
    throw new Error('projection reads must not call MCP')
  })

  const result = await handlers.readProjection({ statePath })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual((result.data as { tasks: unknown[] }).tasks, [])
}

async function testReadProjectionSurfacesUnavailableAndInvalidProjection(): Promise<void> {
  const { statePath, teamDir } = await createStateFixture()
  const handlers = createHandlers(async () => {
    throw new Error('projection reads must not call MCP')
  })

  await rm(join(teamDir, 'projection.json'))
  const missingProjection = await handlers.readProjection({ statePath })
  assert.equal(missingProjection.ok, false)
  if (!missingProjection.ok) assert.match(missingProjection.message, /projection\.json|ENOENT/u)

  await writeFile(join(teamDir, 'projection.json'), '{not-json', 'utf-8')
  const invalidProjection = await handlers.readProjection({ statePath })
  assert.equal(invalidProjection.ok, false)
  if (!invalidProjection.ok) assert.match(invalidProjection.message, /JSON|Unexpected|property name/u)
}

async function testReadRegistryRolesUsesMcpTool(): Promise<void> {
  const { workspaceRoot } = await createStateFixture()
  const calls: Array<{ tool: string; payload: Record<string, unknown>; actor: { role: string } }> = []
  const handlers = createHandlers(async (_context, tool, payload, actor) => {
    calls.push({ tool, payload, actor })
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      response: {
        ok: true,
        tool,
        result: {
          ok: true,
          roles: [{ id: 'marketer', label: 'Marketer', source: { layer: 'workspace' } }],
          warnings: [],
        },
      },
    }
  })

  const result = await handlers.readRegistryRoles({ workspaceRoot, includeShadowed: true })
  assert.equal(result.ok, true)
  assert.equal(calls[0]?.tool, 'sprintengine.roles.list')
  assert.deepEqual(calls[0]?.payload, { workspaceRoot, includeShadowed: true, pluginRegistryRoots: [] })
  assert.equal(calls[0]?.actor.role, 'renderer')
}

async function testReadRegistryRolesPassesLoadedPluginSoulsRoots(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-sprintengine-plugin-bridge-'))
  const pluginRoot = join(workspaceRoot, 'plugins', 'writer-plugin')
  const soulsRoot = join(pluginRoot, 'sprintengine-souls')
  await mkdir(join(soulsRoot, 'roles'), { recursive: true })
  await mkdir(join(soulsRoot, 'skills', 'plugin_writer'), { recursive: true })
  await writeFile(
    join(pluginRoot, 'plugin.json'),
    JSON.stringify({
      id: 'writer-plugin',
      displayName: 'Writer Plugin',
      version: 1,
      binary: 'writer',
      permissionPresets: { default: { label: 'Default', args: [] } },
      launch: { argv: ['writer'] },
      promptInjection: { mode: 'stdin-pipe' },
      completion: { mode: 'process-exit' },
      capabilities: { resumeSession: false, sessionIdFromCaller: false, toolUse: false, mcpServers: false },
      souls: { directory: 'sprintengine-souls' },
    }),
    'utf-8'
  )

  const registry = createPluginRegistry({ bundledRoot: join(workspaceRoot, 'empty-bundled'), userRoot: join(workspaceRoot, 'plugins') })
  const report = registry.loadSync()
  __setPluginRegistryForTest(registry, report)
  const calls: Array<{ context: { workspaceRoot: string; allowedRoots?: string[] }; payload: Record<string, unknown> }> = []
  const handlers = createHandlers(async (context, _tool, payload) => {
    calls.push({ context, payload })
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      response: { ok: true, tool: 'sprintengine.roles.list', result: { ok: true, roles: [], warnings: [] } },
    }
  })

  try {
    const result = await handlers.readRegistryRoles({ workspaceRoot })
    assert.equal(result.ok, true)
    assert.deepEqual(calls[0]?.payload.pluginRegistryRoots, [{ id: 'writer-plugin', root: soulsRoot }])
    assert.deepEqual(calls[0]?.context.allowedRoots, [soulsRoot])
  } finally {
    __resetPluginRegistryForTest()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

async function testReadRegistryRolesUsesRealMcpBridgeForBundledAndCustomRoles(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-sprintengine-registry-'))
  const previousPythonPath = process.env.PYTHONPATH
  const rolePath = join(workspaceRoot, '.sprintengine', 'roles', 'marketer.json')
  const skillPath = join(workspaceRoot, '.sprintengine', 'skills', 'marketer', 'SKILL.md')
  await mkdir(join(workspaceRoot, '.sprintengine', 'roles'), { recursive: true })
  await mkdir(join(workspaceRoot, '.sprintengine', 'skills', 'marketer'), { recursive: true })
  await writeFile(
    rolePath,
    JSON.stringify({
      id: 'marketer',
      label: 'Marketer',
      aliases: ['growth-marketer'],
      summary: 'Tests workspace custom role discovery.',
      soul: [{ skill: 'marketer' }],
    }, null, 2),
    'utf-8'
  )
  await writeFile(skillPath, 'Workspace marketer test skill.\n', 'utf-8')

  try {
    process.env.PYTHONPATH = [process.cwd(), previousPythonPath].filter(Boolean).join(delimiter)
    const handlers = createSprintEngineArtifactHandlers({
      getAuthenticatedUserId: () => 'user-1',
      openExternal: async () => undefined,
    })
    const result = await handlers.readRegistryRoles({ workspaceRoot, includeShadowed: true })
    assert.equal(result.ok, true)
    if (!result.ok) return

    const payload = result.data as {
      roles?: Array<{ id?: string; label?: string; source?: { layer?: string } }>
      aliases?: Record<string, string>
    }
    const roleIds = new Set((payload.roles ?? []).map((role) => role.id))
    assert.equal(roleIds.has('developer'), true, 'bundled developer role is discovered through the real MCP bridge')
    assert.equal(roleIds.has('marketer'), true, 'workspace custom role fixture is discovered through the real MCP bridge')
    assert.equal(payload.roles?.find((role) => role.id === 'marketer')?.source?.layer, 'workspace')
    assert.equal(payload.aliases?.growth_marketer, 'marketer')
  } finally {
    if (previousPythonPath === undefined) {
      delete process.env.PYTHONPATH
    } else {
      process.env.PYTHONPATH = previousPythonPath
    }
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

async function testReadRegistryRoleSurfacesUnknownRole(): Promise<void> {
  const { workspaceRoot } = await createStateFixture()
  const handlers = createHandlers(async (_context, tool) => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    response: {
      ok: false,
      tool,
      error: { code: 'unknown_role', message: 'Unknown registry role: marketer.' },
    },
  }))

  const result = await handlers.readRegistryRole({ workspaceRoot, roleId: 'marketer' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.message, /Unknown registry role/)
}

async function testReadDispatchUsesMcpTool(): Promise<void> {
  const { workspaceRoot, statePath } = await createStateFixture()
  const calls: Array<{ context: { workspaceRoot: string }; tool: string; payload: Record<string, unknown> }> = []
  const handlers = createHandlers(async (context, tool, payload) => {
    calls.push({ context, tool, payload })
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      response: {
        ok: true,
        tool,
        result: {
          ok: true,
          currentDispatch: { dispatchId: 'DISP-1', targetKind: 'task', taskId: 'T1' },
          dispatches: [],
        },
      },
    }
  })

  const result = await handlers.readDispatch({ statePath, agentId: 'developer-1', lastDispatchId: 'DISP-0' })
  assert.equal(result.ok, true)
  assert.equal(calls[0]?.context.workspaceRoot, workspaceRoot)
  assert.equal(calls[0]?.tool, 'sprintengine.dispatch.next')
  assert.deepEqual(calls[0]?.payload, { statePath, agentId: 'developer-1', lastDispatchId: 'DISP-0' })
}

async function testReadBridgeSurfacesUnavailableMcpAndMalformedPayloads(): Promise<void> {
  const { statePath } = await createStateFixture()
  const handlers = createHandlers(async () => ({
    exitCode: 1,
    stdout: '',
    stderr: 'mcp unavailable',
    response: null,
  }))

  const unavailable = await handlers.readDispatch({ statePath, agentId: 'developer-1' })
  assert.equal(unavailable.ok, false)
  if (!unavailable.ok) assert.match(unavailable.message, /mcp unavailable/)

  const malformed = await handlers.readDispatch({ statePath, agentId: '' })
  assert.equal(malformed.ok, false)
  if (!malformed.ok) assert.match(malformed.message, /Agent id is required/)

  const malformedRegistry = await handlers.readRegistryRoles({ workspaceRoot: '' })
  assert.equal(malformedRegistry.ok, false)
  if (!malformedRegistry.ok) assert.match(malformedRegistry.message, /Workspace root is required/)

  const malformedRegistryRole = await handlers.readRegistryRole({ workspaceRoot: statePath, roleId: '' })
  assert.equal(malformedRegistryRole.ok, false)
  if (!malformedRegistryRole.ok) assert.match(malformedRegistryRole.message, /Workspace root does not exist|Role id is required/)

  const malformedProjection = await handlers.readProjection({ statePath: 'relative/run.yaml' })
  assert.equal(malformedProjection.ok, false)
  if (!malformedProjection.ok) assert.match(malformedProjection.message, /absolute/)
}

async function testIpcRegistersReadOnlyBridgeChannels(): Promise<void> {
  const calls: string[] = []
  const handlers = new Map<string, IpcHandler>()
  const ipcMain = {
    handle(channel: string, handler: IpcHandler) {
      handlers.set(channel, handler)
    },
  }
  registerSprintEngineIpc(ipcMain as never, {
    openArtifact: async () => ({ ok: true, data: null }),
    reviewArtifact: async () => ({ ok: true, data: null }),
    readyTask: async () => ({ ok: true, data: null }),
    initializeSprintEngineState: async () => ({ ok: true, data: null }),
    updateTask: async () => ({ ok: true, data: null }),
    createTask: async () => ({ ok: true, data: null }),
    commentTask: async () => ({ ok: true, data: null }),
    setRunnerMode: async () => ({ ok: true, data: null }),
    replenishRoster: async () => ({ ok: true, data: null }),
    readProjection: async () => ({ ok: true, data: null }),
    readRegistryRoles: async () => {
      calls.push('roles')
      return { ok: true, data: null }
    },
    readRegistryRole: async () => {
      calls.push('role')
      return { ok: true, data: null }
    },
    readDispatch: async () => {
      calls.push('dispatch')
      return { ok: true, data: null }
    },
  })

  await handlers.get('sprintengine:registry:roles:read')?.(null, { workspaceRoot: '/tmp/workspace' })
  await handlers.get('sprintengine:registry:role:read')?.(null, { workspaceRoot: '/tmp/workspace', roleId: 'developer' })
  await handlers.get('sprintengine:dispatch:read')?.(null, { statePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml', agentId: 'developer-1' })

  assert.deepEqual(calls, ['roles', 'role', 'dispatch'])
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
