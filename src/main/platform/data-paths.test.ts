import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { createNodeStudioPlatform, installStudioPlatform, resetStudioPlatform } from '../../server/platform/platform'
import { resolveAgentStateSocketPath } from '../agent-state-service'
import { writeDiagnosticLog } from '../diagnostics-service'
import { agentIdentityEnv } from '../terminal-launch'

// The files server-bound code writes beside the app's data (the agent-state
// socket a launch names, the diagnostics log) are placed by the installed
// platform's paths, and a launch built with no platform installed still omits
// the socket rather than failing.

const directories: string[] = []
afterEach(async () => {
  resetStudioPlatform()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

test('a launch names the agent-state socket in the platform data directory, and none without a platform', () => {
  assert.equal(agentIdentityEnv({ agentId: 'agent-1' }).SPRINTENGINE_AGENT_STATE_SOCKET, undefined)

  installStudioPlatform(createNodeStudioPlatform({ dataDir: '/Users/dev/studio-data', version: '0.0.0' }))
  assert.equal(
    agentIdentityEnv({ agentId: 'agent-1' }).SPRINTENGINE_AGENT_STATE_SOCKET,
    resolveAgentStateSocketPath('/Users/dev/studio-data'),
  )
})

test('diagnostics are appended in the platform logs directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-data-paths-'))
  directories.push(root)
  const logsDir = join(root, 'logs')
  installStudioPlatform(createNodeStudioPlatform({ dataDir: join(root, 'data'), logsDir, version: '0.0.0' }))

  const entry = await writeDiagnosticLog({ level: 'info', source: 'agents', title: 'Probe', message: 'written' })
  const logPath = entry.logPath ?? ''
  assert.equal(logPath.startsWith(logsDir), true)
  assert.match(await readFile(logPath, 'utf8'), /"title":"Probe"/)
})
