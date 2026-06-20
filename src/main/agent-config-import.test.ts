import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { McpSyncInput, McpSyncResult } from '../shared/electron-api'
import { createAgentConfigImportService } from './agent-config-import'
import { createBuiltinSkillManager } from './builtin-skills'

async function writeSkillSource(root: string, skillId: string, body = `${skillId} source\n`): Promise<void> {
  const skillRoot = join(root, skillId)
  await mkdir(skillRoot, { recursive: true })
  await writeFile(join(skillRoot, 'SKILL.md'), body, 'utf-8')
}

function createService(input: {
  homeRoot: string
  sourceRoot: string
  syncCalls?: McpSyncInput[]
}) {
  const syncCalls = input.syncCalls ?? []
  return createAgentConfigImportService({
    homeDir: () => input.homeRoot,
    builtinSkillManager: createBuiltinSkillManager({
      sourceRoot: input.sourceRoot,
      listPlugins: () => [],
    }),
    mcpConfigService: {
      sync(syncInput: McpSyncInput): McpSyncResult {
        syncCalls.push(syncInput)
        return { ok: true, targets: [], issues: [] }
      },
    },
  })
}

async function writeCodexMcp(homeRoot: string): Promise<void> {
  await mkdir(join(homeRoot, '.codex'), { recursive: true })
  await writeFile(
    join(homeRoot, '.codex', 'config.toml'),
    [
      '[mcp_servers.context7]',
      'command = "node"',
      'args = ["server.js", "--token", "SECRET_ARG"]',
      'env = { "CONTEXT7_TOKEN" = "SECRET_ENV_VALUE" }',
      'env_vars = ["CONTEXT7_TOKEN"]',
      '',
    ].join('\n'),
    'utf-8',
  )
}

async function writeClaudeMcp(homeRoot: string): Promise<void> {
  await mkdir(join(homeRoot, '.claude'), { recursive: true })
  await writeFile(
    join(homeRoot, '.claude', '.mcp.json'),
    `${JSON.stringify({
      mcpServers: {
        sentry: {
          type: 'http',
          url: 'https://mcp.sentry.example/mcp',
          headers: { Authorization: 'Bearer SECRET_HEADER_VALUE' },
        },
      },
    }, null, 2)}\n`,
    'utf-8',
  )
}

async function testNothingPresent(): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'multicode-agent-config-empty-'))
  const service = createService({
    homeRoot: join(temp, 'home'),
    sourceRoot: join(temp, 'source'),
  })

  const result = await service.detect()
  assert.equal(result.ok, true)
  assert.deepEqual(result.ok && result.mcpServers, [])
  assert.deepEqual(result.ok && result.skills, [])
  assert.deepEqual(result.ok && result.warnings, [])
}

async function testPartialMcpOnly(): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'multicode-agent-config-partial-'))
  const homeRoot = join(temp, 'home')
  await writeCodexMcp(homeRoot)
  const service = createService({
    homeRoot,
    sourceRoot: join(temp, 'source'),
  })

  const result = await service.detect()
  assert.equal(result.ok, true)
  assert.deepEqual(result.ok && result.mcpServers.map((server) => server.id), ['context7'])
  assert.deepEqual(result.ok && result.skills, [])
  assert.equal(result.ok && result.mcpServers[0]?.source, 'codex')
  assert.equal(result.ok && result.mcpServers[0]?.hasSecretValues, true)
  assert.equal(JSON.stringify(result).includes('SECRET'), false, 'detect result must not echo token-like values')
}

async function testFullConfig(): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'multicode-agent-config-full-'))
  const homeRoot = join(temp, 'home')
  await writeCodexMcp(homeRoot)
  await writeClaudeMcp(homeRoot)
  await mkdir(join(homeRoot, '.codex', 'skills', 'backlog'), { recursive: true })
  await mkdir(join(homeRoot, '.claude', 'skills', 'custom-local'), { recursive: true })
  const service = createService({
    homeRoot,
    sourceRoot: join(temp, 'source'),
  })

  const result = await service.detect()
  assert.equal(result.ok, true)
  assert.deepEqual(result.ok && result.mcpServers.map((server) => server.id).sort(), ['context7', 'sentry'])
  assert.deepEqual(result.ok && result.skills.map((skill) => skill.id).sort(), ['backlog', 'custom-local'])
  assert.equal(result.ok && result.skills.find((skill) => skill.id === 'backlog')?.adoptable, true)
  assert.equal(result.ok && result.skills.find((skill) => skill.id === 'custom-local')?.adoptable, false)
  assert.equal(JSON.stringify(result).includes('SECRET'), false, 'full detect result must stay sanitized')
}

async function testAdoptUsesExistingSyncPaths(): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'multicode-agent-config-adopt-'))
  const homeRoot = join(temp, 'home')
  const sourceRoot = join(temp, 'source')
  const workspaceRoot = join(temp, 'workspace')
  const syncCalls: McpSyncInput[] = []
  await mkdir(workspaceRoot, { recursive: true })
  await writeSkillSource(sourceRoot, 'backlog')
  await writeCodexMcp(homeRoot)
  await writeClaudeMcp(homeRoot)
  await mkdir(join(homeRoot, '.codex', 'skills', 'backlog'), { recursive: true })
  const service = createService({ homeRoot, sourceRoot, syncCalls })
  const detected = await service.detect()
  assert.equal(detected.ok, true)

  const result = await service.adopt({
    workspaceRoot,
    mcpServerKeys: detected.ok ? detected.mcpServers.map((server) => server.key) : [],
    skillKeys: detected.ok ? [detected.skills.find((skill) => skill.id === 'backlog')!.key] : [],
  })

  assert.equal(result.ok, true)
  assert.equal(syncCalls.length, 1, 'adopt should route MCP writes through mcp-config-service')
  assert.deepEqual(Object.keys(syncCalls[0]!.settings.servers).sort(), ['context7', 'sentry'])
  assert.equal(syncCalls[0]!.settings.servers.context7?.env?.CONTEXT7_TOKEN, 'SECRET_ENV_VALUE')
  assert.equal(syncCalls[0]!.settings.servers.sentry?.headers?.Authorization, 'Bearer SECRET_HEADER_VALUE')
  assert.deepEqual(result.ok && result.adoptedMcpServers.map((server) => server.id).sort(), ['context7', 'sentry'])
  assert.deepEqual(result.ok && result.adoptedSkills, [{ id: 'backlog', status: 'installed' }])
  assert.equal(await readFile(join(workspaceRoot, '.agents', 'skills', 'backlog', 'SKILL.md'), 'utf-8'), 'backlog source\n')
  assert.equal(JSON.stringify(result).includes('SECRET'), false, 'adopt result must not echo token-like values')
}

async function main(): Promise<void> {
  await testNothingPresent()
  await testPartialMcpOnly()
  await testFullConfig()
  await testAdoptUsesExistingSyncPaths()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
