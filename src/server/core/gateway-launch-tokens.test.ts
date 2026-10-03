import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  applyGatewayLaunchTokenChange,
  issueGatewayLaunchToken,
  liveGatewayLaunchTokens,
  onGatewayLaunchTokenChange,
  resolveGatewayLaunchToken,
  revokeGatewayLaunchToken,
  type LaunchTokenChange,
} from './gateway-launch-tokens'

// Out of process the shell issues the launch tokens of the terminals it runs
// and the server's gateway resolves them, so each issue and revoke crosses as
// a digest, never the token, and a restarted server is told every live one.

test('an issue and a revoke are heard by digest, and the token never leaves', () => {
  const heard: LaunchTokenChange[] = []
  const stop = onGatewayLaunchTokenChange((change) => heard.push(change))
  const token = issueGatewayLaunchToken({ workspaceId: 'ws-1', agentId: 'agent-1', cliId: 'claude' })
  revokeGatewayLaunchToken(token)
  revokeGatewayLaunchToken(token)
  stop()
  assert.equal(heard.length, 2, 'a second revoke of a gone token says nothing')
  assert.match(heard[0]!.digest, /^[0-9a-f]{64}$/)
  assert.notEqual(heard[0]!.digest, token)
  assert.deepEqual(heard[0]!.identity, { workspaceId: 'ws-1', agentId: 'agent-1', cliId: 'claude' })
  assert.deepEqual(heard[1], { digest: heard[0]!.digest, identity: null })
  assert.equal(JSON.stringify(heard).includes(token), false)
})

test('a digest applied here resolves the token it was made from, until revoked', () => {
  // The shell's side: issue, hear the digest, and take the token back locally
  // so only the applied copy can resolve it.
  let change: LaunchTokenChange | null = null
  const stop = onGatewayLaunchTokenChange((next) => {
    change ??= next
  })
  const token = issueGatewayLaunchToken({ workspaceId: 'ws-2', agentId: 'agent-2' })
  stop()
  revokeGatewayLaunchToken(token)
  assert.equal(resolveGatewayLaunchToken(token), null)

  applyGatewayLaunchTokenChange(change!)
  assert.deepEqual(resolveGatewayLaunchToken(token), { workspaceId: 'ws-2', agentId: 'agent-2' })
  assert.ok(liveGatewayLaunchTokens().some((live) => live.digest === change!.digest))
  applyGatewayLaunchTokenChange({ digest: change!.digest, identity: null })
  assert.equal(resolveGatewayLaunchToken(token), null)
})

test('a change that is not a digest is ignored', () => {
  const before = liveGatewayLaunchTokens().length
  applyGatewayLaunchTokenChange({ digest: 'not-a-digest', identity: { workspaceId: 'ws', agentId: 'a' } })
  assert.equal(liveGatewayLaunchTokens().length, before)
})
