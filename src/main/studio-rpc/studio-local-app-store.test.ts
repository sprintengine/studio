import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { chmod, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { STUDIO_SCOPES } from '../../../packages/studio-protocol/src/public'
import { STUDIO_LOCAL_APPS_FILENAME, createStudioLocalAppStore } from './studio-local-app-store'
import { createGatewayAuditStore } from '../automation/gateway-audit'
import { readStudioEnvironmentId } from './studio-rpc-service'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
async function dataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'studio-local-apps-'))
  directories.push(directory)
  return directory
}

const offerInput = { name: 'release-bot', scopes: ['conversation:read', 'conversation:create'], ceiling: 'manual' }

test('a pairing code is redeemed once, for exactly the grant Settings named', async () => {
  const dir = await dataDir()
  const store = createStudioLocalAppStore({ resolveUserDataDir: () => dir })
  const { code, offer } = store.offer(offerInput)
  assert.equal(store.offers().length, 1)
  // A wrong guess never burns the outstanding code.
  assert.equal(store.redeem('sepair_wrong_guess_0000000').ok, false)
  const redeemed = store.redeem(code)
  assert.ok(redeemed.ok)
  assert.deepEqual(redeemed.ok && redeemed.grant, {
    clientId: redeemed.ok ? redeemed.grant.clientId : '',
    name: 'release-bot',
    owner: false,
    scopes: ['conversation:read', 'conversation:create'],
    ceiling: 'manual',
  })
  assert.equal(
    store.offers().some((pending) => pending.id === offer.id),
    false,
  )
  assert.deepEqual(store.authenticate(redeemed.ok ? redeemed.token : ''), redeemed.ok ? redeemed.grant : null)
  // The token arrived and was used: the code is spent.
  assert.equal(store.redeem(code).ok, false)
})

test('a code whose token never arrived can be presented again, for the same app and a fresh token', async () => {
  const dir = await dataDir()
  const store = createStudioLocalAppStore({ resolveUserDataDir: () => dir })
  const { code } = store.offer(offerInput)
  const lost = store.redeem(code)
  const retried = store.redeem(code)
  assert.ok(lost.ok && retried.ok)
  assert.equal(retried.grant.clientId, lost.grant.clientId)
  assert.equal(store.list().length, 1)
  // Only the latest token works; the one lost with its welcome is void.
  assert.equal(store.authenticate(lost.token), null)
  assert.equal(store.authenticate(retried.token)?.clientId, lost.grant.clientId)
  assert.equal(store.redeem(code).ok, false)
})

test('only the token’s hash reaches disk, owner-only, and it still authenticates after a restart', async () => {
  const dir = await dataDir()
  const store = createStudioLocalAppStore({ resolveUserDataDir: () => dir })
  const redeemed = store.redeem(store.offer(offerInput).code)
  assert.ok(redeemed.ok)
  const path = join(dir, STUDIO_LOCAL_APPS_FILENAME)
  const body = readFileSync(path, 'utf8')
  assert.equal(body.includes(redeemed.token), false)
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)
  const reloaded = createStudioLocalAppStore({ resolveUserDataDir: () => dir })
  assert.equal(reloaded.authenticate(redeemed.token)?.clientId, redeemed.grant.clientId)
  // An unredeemed code does not survive a restart.
  const { code } = store.offer(offerInput)
  assert.equal(createStudioLocalAppStore({ resolveUserDataDir: () => dir }).redeem(code).ok, false)
})

test('revoking an app tells its listeners and its token stops working at once', async () => {
  const dir = await dataDir()
  const store = createStudioLocalAppStore({ resolveUserDataDir: () => dir })
  const redeemed = store.redeem(store.offer(offerInput).code)
  assert.ok(redeemed.ok)
  const revoked: string[] = []
  store.onRevoked((id) => revoked.push(id))
  assert.equal(store.revoke(redeemed.grant.clientId), true)
  assert.deepEqual(revoked, [redeemed.grant.clientId])
  assert.equal(store.authenticate(redeemed.token), null)
  assert.equal(store.grantFor(redeemed.grant.clientId), null)
  assert.equal(store.revoke(redeemed.grant.clientId), false)
})

test('a code lapses after its window; Settings must name the app, a scope and a ceiling', async () => {
  const dir = await dataDir()
  let now = Date.parse('2026-10-01T10:00:00Z')
  const store = createStudioLocalAppStore({ resolveUserDataDir: () => dir, now: () => new Date(now) })
  const { code } = store.offer(offerInput)
  now += 11 * 60 * 1000
  assert.equal(store.redeem(code).ok, false)
  assert.equal(store.offers().length, 0)
  assert.throws(() => store.offer({ ...offerInput, name: ' ' }), /Name the app/)
  assert.throws(() => store.offer({ ...offerInput, scopes: ['terminal:control'] }), /at least one/)
  assert.throws(() => store.offer({ ...offerInput, ceiling: 'yolo' }), /loosest permission preset/)
})

test('the owner token is minted in memory for this run only and grants everything', async () => {
  const dir = await dataDir()
  const store = createStudioLocalAppStore({ resolveUserDataDir: () => dir })
  assert.equal(store.grantFor('owner'), null)
  const token = store.ownerToken()
  assert.equal(store.ownerToken(), token)
  assert.deepEqual(store.authenticate(token), {
    clientId: 'owner',
    name: 'SprintEngine Studio',
    owner: true,
    scopes: [...STUDIO_SCOPES],
    ceiling: 'bypass',
  })
  assert.equal(createStudioLocalAppStore({ resolveUserDataDir: () => dir }).authenticate(token), null)
})

test('a local app is recorded in the gateway audit by the identity its token proved', async () => {
  const dir = await dataDir()
  const audit = createGatewayAuditStore({ resolveUserDataDir: () => dir })
  audit.record({
    connection: { kind: 'studio-client', clientId: 'sla_1', clientName: 'release-bot' },
    tool: 'conversation.send',
    durationMs: 3,
    args: { workspaceId: 'ws-1', agentId: 'agent-1', id: 'cmd-1', message: 'never recorded' },
  })
  await audit.close()
  const line = JSON.parse((await readFile(join(dir, 'sprintengine-studio-mcp-audit.jsonl'), 'utf8')).trim())
  assert.deepEqual(line.connection, { kind: 'studio-client', clientId: 'sla_1', clientName: 'release-bot' })
  assert.deepEqual(line.targets, { workspaceId: 'ws-1', agentId: 'agent-1', id: 'cmd-1' })
})

test('a data directory keeps one environment id for good', async () => {
  const dir = await dataDir()
  const id = readStudioEnvironmentId(dir)
  assert.match(id, /^[0-9a-f-]{36}$/)
  assert.equal(readStudioEnvironmentId(dir), id)
})

test.runIf(process.platform !== 'win32')(
  'a revoke whose write fails still closes the app now, and still says the write failed',
  async () => {
    const dir = await dataDir()
    const store = createStudioLocalAppStore({ resolveUserDataDir: () => dir })
    const redeemed = store.redeem(store.offer(offerInput).code)
    assert.ok(redeemed.ok)
    const revoked: string[] = []
    store.onRevoked((id) => revoked.push(id))
    await chmod(dir, 0o500)
    try {
      assert.throws(() => store.revoke(redeemed.grant.clientId), /EACCES|permission/i)
    } finally {
      await chmod(dir, 0o700)
    }
    assert.deepEqual(revoked, [redeemed.grant.clientId])
    assert.equal(store.authenticate(redeemed.token), null)
    // No half-written file was left beside the store.
    assert.deepEqual(
      (await readdir(dir)).filter((name) => name.endsWith('.tmp')),
      [],
    )
  },
)

test('an app that may offer tools has a reach, which the person may change; one that may not stays own', async () => {
  const dir = await dataDir()
  const store = createStudioLocalAppStore({ resolveUserDataDir: () => dir })
  const tooled = store.offer({ ...offerInput, name: 'game', scopes: ['tools:offer'], toolReach: 'all' })
  assert.equal(tooled.offer.toolReach, 'all')
  const plain = store.offer({ ...offerInput, toolReach: 'all' })
  assert.equal(plain.offer.toolReach, 'own')
  const game = store.redeem(tooled.code)
  const bot = store.redeem(plain.code)
  assert.ok(game.ok && bot.ok)
  assert.equal(store.toolReachOf(game.grant.clientId), 'all')
  assert.equal(store.setToolReach(game.grant.clientId, 'own'), true)
  assert.equal(store.setToolReach(bot.grant.clientId, 'all'), false)
  // Kept across a restart; a pairing stored before reach existed reads as own.
  const again = createStudioLocalAppStore({ resolveUserDataDir: () => dir })
  assert.equal(again.toolReachOf(game.grant.clientId), 'own')
  assert.equal(again.toolReachOf('sla_unknown'), 'own')
})
