import assert from 'node:assert/strict'

// The Connectors row's model (MC-2124). Two contracts matter here:
//
// 1. The picker reflects the ONE app-level selection and toggles it
//    non-destructively — a server switched off keeps its configuration.
// 2. `syncSprintConnectors` fails CLOSED with an actionable message, treating
//    an `ok: false` result, an `error`-level issue and a thrown error alike —
//    the contract `persistAdvancedSetup` already has, so the same failure reads
//    the same way whichever surface created the workspace. "Nothing to write"
//    is not a failure.

import type { McpServerConfig, McpSettings, McpSyncResult } from '../../../../../shared/electron-api'
import {
  SPRINT_CONNECTOR_FAILURE_PREFIX,
  listSprintConnectors,
  sprintConnectorsSummary,
  syncSprintConnectors,
  toggledSprintConnector,
} from './sprintConnectors'

function server(id: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id,
    name: overrides.name ?? id,
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
    enabled: true,
    clients: ['claude-code'],
    scope: 'workspace',
    source: 'bundled',
    riskLevel: 'low',
    ...overrides,
  } as McpServerConfig
}

function settingsWith(...servers: McpServerConfig[]): McpSettings {
  return {
    syncEnabled: true,
    servers: Object.fromEntries(servers.map((entry) => [entry.id, entry])),
  }
}

let failures = 0
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`ok - ${name}`)
    })
    .catch((error) => {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    })
}

async function main(): Promise<void> {
  await check('the picker lists active connectors first, then alphabetically', () => {
    const rows = listSprintConnectors(
      settingsWith(
        server('zeta', { name: 'Zeta', enabled: true }),
        server('alpha', { name: 'Alpha', enabled: false }),
        server('beta', { name: 'Beta', enabled: true }),
      ),
    )
    assert.deepEqual(
      rows.map((row) => row.id),
      ['beta', 'zeta', 'alpha'],
      'active first, each band by name',
    )
  })

  await check('the row states what the sprint gets, not what exists', () => {
    assert.equal(sprintConnectorsSummary([], true), 'None installed')
    const rows = listSprintConnectors(
      settingsWith(server('a', { enabled: true }), server('b', { enabled: false })),
    )
    assert.equal(sprintConnectorsSummary(rows, true), '1 active')
    // Sync off means no connector reaches any agent, whatever is ticked.
    assert.equal(sprintConnectorsSummary(rows, false), 'Sync off')
    const none = listSprintConnectors(settingsWith(server('a', { enabled: false })))
    assert.equal(sprintConnectorsSummary(none, true), 'None active')
  })

  await check('toggling off keeps the server and its configuration', () => {
    const settings = settingsWith(
      server('github', { enabled: true, env: { TOKEN: 'x' }, headers: { A: 'b' } }),
    )
    const off = toggledSprintConnector(settings, 'github')
    assert.ok(off, 'a known server toggles')
    assert.equal(off!.enabled, false, 'the toggle flips enabled')
    assert.deepEqual(off!.env, { TOKEN: 'x' }, 'hand-entered env survives being switched off')
    assert.deepEqual(off!.headers, { A: 'b' }, 'headers survive too')
    const on = toggledSprintConnector({ ...settings, servers: { github: off! } }, 'github')
    assert.equal(on!.enabled, true, 'and it toggles back')
    assert.equal(toggledSprintConnector(settings, 'nope'), null, 'an unknown id writes nothing')
  })

  await check('nothing to write is not a failure, and calls no sync', async () => {
    let calls = 0
    const mcpSync = async (): Promise<McpSyncResult> => {
      calls += 1
      return { ok: true, targets: [], issues: [] }
    }
    assert.equal(
      await syncSprintConnectors({ workspaceRoot: null, settings: settingsWith(server('a')), mcpSync }),
      null,
      'no workspace root',
    )
    assert.equal(
      await syncSprintConnectors({
        workspaceRoot: '/proj',
        settings: { syncEnabled: false, servers: { a: server('a') } },
        mcpSync,
      }),
      null,
      'sync switched off app-wide',
    )
    assert.equal(
      await syncSprintConnectors({
        workspaceRoot: '/proj',
        settings: settingsWith(server('a', { enabled: false })),
        mcpSync,
      }),
      null,
      'no server enabled',
    )
    assert.equal(calls, 0, 'none of those reached the writer')
  })

  await check('an enabled connector is written into the project', async () => {
    const calls: Array<{ workspaceRoot: string; ids: string[] }> = []
    const message = await syncSprintConnectors({
      workspaceRoot: '/proj',
      settings: settingsWith(server('github'), server('linear', { enabled: false })),
      mcpSync: async (input) => {
        calls.push({
          workspaceRoot: input.workspaceRoot,
          ids: Object.values(input.settings.servers)
            .filter((entry) => entry.enabled)
            .map((entry) => entry.id),
        })
        return { ok: true, targets: [], issues: [] }
      },
    })
    assert.equal(message, null, 'a clean write reports nothing')
    assert.deepEqual(calls, [{ workspaceRoot: '/proj', ids: ['github'] }])
  })

  await check('every failure shape returns the same actionable message', async () => {
    const refused = await syncSprintConnectors({
      workspaceRoot: '/proj',
      settings: settingsWith(server('a')),
      mcpSync: async () => ({ ok: false, message: 'Workspace root does not exist.' }),
    })
    assert.equal(refused, `${SPRINT_CONNECTOR_FAILURE_PREFIX}Workspace root does not exist.`)

    const blocked = await syncSprintConnectors({
      workspaceRoot: '/proj',
      settings: settingsWith(server('a')),
      mcpSync: async () => ({
        ok: true,
        targets: [],
        // ok:true with an error-level issue is the shape that would otherwise
        // read as success and produce a toolless run.
        issues: [
          { level: 'warning', message: 'skipping a CLI without a writer' },
          { level: 'error', message: 'Server "a" has no command.' },
        ],
      }),
    })
    assert.equal(blocked, `${SPRINT_CONNECTOR_FAILURE_PREFIX}Server "a" has no command.`)

    const threw = await syncSprintConnectors({
      workspaceRoot: '/proj',
      settings: settingsWith(server('a')),
      mcpSync: async () => {
        throw new Error('ipc gone')
      },
    })
    assert.equal(threw, `${SPRINT_CONNECTOR_FAILURE_PREFIX}ipc gone`)

    const warned = await syncSprintConnectors({
      workspaceRoot: '/proj',
      settings: settingsWith(server('a')),
      mcpSync: async () => ({
        ok: true,
        targets: [],
        issues: [{ level: 'warning', message: 'a CLI without a writer' }],
      }),
    })
    assert.equal(warned, null, 'a warning is not a refusal')
  })

  await check('enabled connectors with no writer at all is a failure, not a skip', async () => {
    const message = await syncSprintConnectors({
      workspaceRoot: '/proj',
      settings: settingsWith(server('a')),
      mcpSync: undefined,
    })
    assert.ok(
      message?.startsWith(SPRINT_CONNECTOR_FAILURE_PREFIX),
      'a build that cannot write MCP config says so rather than creating a toolless run',
    )
  })

  if (failures > 0) {
    console.error(`${failures} check(s) failed`)
    process.exitCode = 1
  }
}

void main()
