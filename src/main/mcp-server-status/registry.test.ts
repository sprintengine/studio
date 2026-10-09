import { afterEach, expect, test } from 'vitest'

import { withReportedStatus } from '../workspace-skills-service'
import { clearMcpServerStatus, isMcpServerStatus, mcpServerStatusFor, publishMcpServerStatus } from './registry'

afterEach(() => clearMcpServerStatus())

test('a whole report replaces the folder’s list; a single report updates one server', () => {
  publishMcpServerStatus({
    cli: 'claude-code',
    cwd: '/Users/dev/app',
    replace: true,
    servers: [
      { id: 'github', status: 'connected' },
      { id: 'linear', status: 'needs-auth' },
    ],
  })
  publishMcpServerStatus({
    cli: 'claude-code',
    cwd: '/Users/dev/app/',
    servers: [{ id: 'linear', status: 'connected' }],
  })
  expect([...mcpServerStatusFor('claude-code', '/Users/dev/app').values()]).toEqual([
    { id: 'github', status: 'connected' },
    { id: 'linear', status: 'connected' },
  ])
  publishMcpServerStatus({ cli: 'claude-code', cwd: '/Users/dev/app', replace: true, servers: [] })
  expect(mcpServerStatusFor('claude-code', '/Users/dev/app').size).toBe(0)
  // Another CLI, or another folder, is its own list.
  expect(mcpServerStatusFor('codex', '/Users/dev/app').size).toBe(0)
})

test('configured servers carry what the CLI reported, and servers only it knows are added', () => {
  publishMcpServerStatus({
    cli: 'codex',
    cwd: '/Users/dev/app',
    servers: [
      { id: 'github', status: 'failed', error: 'spawn npx ENOENT' },
      { id: 'notion', status: 'needs-auth' },
    ],
  })
  const servers = withReportedStatus(
    [
      { id: 'github', transport: 'stdio', scope: 'workspace', configPath: '/Users/dev/app/.codex/config.toml' },
      { id: 'sentry', transport: 'http', scope: 'user', configPath: '/Users/dev/.codex/config.toml' },
    ],
    mcpServerStatusFor('codex', '/Users/dev/app'),
  )
  expect(servers.map((server) => [server.id, server.scope, server.status, server.error])).toEqual([
    ['github', 'workspace', 'failed', 'spawn npx ENOENT'],
    ['sentry', 'user', undefined, undefined],
    ['notion', 'session', 'needs-auth', undefined],
  ])
})

test('only the statuses the picker can say are taken', () => {
  expect(['connected', 'failed', 'needs-auth', 'pending', 'disabled'].every(isMcpServerStatus)).toBe(true)
  expect(isMcpServerStatus('ready')).toBe(false)
  expect(isMcpServerStatus(undefined)).toBe(false)
})
