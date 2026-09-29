import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync, mkdirSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import type { ConversationEvent } from '../../../shared/conversation-runtime'
import { TAILNET_SCOPES, type TailnetScope } from '../../../shared/tailnet'
import { ConversationRuntime } from '../../conversation-runtime'
import type { ConversationProviderAdapter } from '../../providers/conversation-provider-adapter'
import { createMockConversationProvider } from '../../providers/mock-conversation-provider'
import { createConversationGatewayHost } from './tailnet-conversation-host'
import {
  CONVERSATION_IMAGE_MAX_BYTES,
  conversationImagePathOf,
  sniffConversationImage,
} from './tailnet-conversation-images'
import { createTailnetDeviceStore } from './tailnet-devices'
import { createTailnetGatewayServer, type TailnetGatewayServer } from './tailnet-gateway-server'
import { createTailnetPeerResolver } from './tailnet-peer-identity'
import {
  TAILNET_CAPABILITIES,
  TAILNET_CONVERSATION_IMAGE_PATH,
  TAILNET_HEALTH_PATH,
  TAILNET_IDENTITY_PATH,
  TAILNET_PAIR_PATH,
} from './tailnet-routes'

// The conversation-image route, end to end: a real gateway on loopback, the
// real conversation host, and a runtime whose transcript recorded the steps a
// provider announced. What the route serves is decided by that record and by
// the file's own bytes, so both are real here.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')])
const GIF = Buffer.from('GIF89a\u0001\u0000\u0001\u0000', 'latin1')

const workspaceId = 'workspace'
const agentId = 'agent'

type Step = { id: string; name: string; kind?: string; input: Record<string, unknown> }

/** A provider whose turn announces the steps its message lists, as JSON. */
function stepProvider(): ConversationProviderAdapter {
  const base = createMockConversationProvider()
  return {
    ...base,
    sendTurn(input) {
      const event = (type: ConversationEvent['type'], payload: Record<string, unknown>): ConversationEvent => ({
        id: '',
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        providerId: input.providerId,
        modelId: input.modelId,
        createdAt: 1,
        type,
        payload,
      })
      const steps = JSON.parse(input.message) as Step[]
      return [
        event('turn_started', { turnId: input.turnId }),
        ...steps.flatMap((step) => [
          event('tool_started', {
            turnId: input.turnId,
            toolUseId: step.id,
            name: step.name,
            ...(step.kind ? { kind: step.kind } : {}),
            input: step.input,
          }),
          event('tool_output', { turnId: input.turnId, toolUseId: step.id, output: 'done', status: 'ok' }),
        ]),
        event('turn_completed', { turnId: input.turnId }),
      ]
    },
  }
}

let workspaceRoot: string
let devicesDir: string
let files: string
let runtime: ConversationRuntime
let server: TailnetGatewayServer
let port: number
let reader: string
let noConversations: string

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'conversation-images-workspace-'))
  devicesDir = mkdtempSync(join(tmpdir(), 'conversation-images-devices-'))
  files = mkdtempSync(join(tmpdir(), 'conversation-images-files-'))
  writeFileSync(join(files, 'generated.png'), PNG)
  // Named .png, but the bytes are a JPEG: the bytes decide.
  writeFileSync(join(files, 'screenshot.png'), JPEG)
  writeFileSync(join(workspaceRoot, 'relative.gif'), GIF)
  writeFileSync(join(files, 'notes.png'), 'these are words, not a picture')
  writeFileSync(join(files, 'notes.txt'), 'plain text')
  writeFileSync(join(files, 'huge.png'), PNG)
  truncateSync(join(files, 'huge.png'), CONVERSATION_IMAGE_MAX_BYTES + 1)
  writeFileSync(join(files, 'linked-target.webp'), WEBP)
  symlinkSync(join(files, 'linked-target.webp'), join(files, 'linked.webp'))
  mkdirSync(join(files, 'folder.png'))

  const provider = stepProvider()
  runtime = new ConversationRuntime({ adapters: [provider], getProviderById: () => undefined })
  const host = createConversationGatewayHost(
    runtime,
    (id) => (id === workspaceId ? workspaceRoot : null),
    () => [{ workspaceRoot, workspaceId }],
  )
  const started = await runtime.startSession({
    workspaceRoot,
    workspaceId,
    agentId,
    providerId: provider.id,
    modelId: provider.listModels()[0],
    permissionPreset: 'bypass',
  })
  assert.ok(started.ok)
  const steps: Step[] = [
    // Codex announces a picture twice: once as it starts, and again with the
    // path once the picture is saved. The second word is the one that stands.
    { id: 'generate', name: 'GenerateImage', kind: 'other', input: { prompt: 'a lighthouse' } },
    {
      id: 'generate',
      name: 'GenerateImage',
      kind: 'other',
      input: { prompt: 'a lighthouse', path: join(files, 'generated.png') },
    },
    { id: 'read-image', name: 'Read', kind: 'file_read', input: { file_path: join(files, 'screenshot.png') } },
    { id: 'read-relative', name: 'Read', input: { path: 'relative.gif' } },
    { id: 'read-linked', name: 'Read', kind: 'file_read', input: { filePath: join(files, 'linked.webp') } },
    { id: 'read-text', name: 'Read', kind: 'file_read', input: { file_path: join(files, 'notes.txt') } },
    { id: 'read-words', name: 'Read', kind: 'file_read', input: { file_path: join(files, 'notes.png') } },
    { id: 'read-huge', name: 'Read', kind: 'file_read', input: { file_path: join(files, 'huge.png') } },
    { id: 'read-missing', name: 'Read', kind: 'file_read', input: { file_path: join(files, 'gone.png') } },
    { id: 'read-folder', name: 'Read', kind: 'file_read', input: { file_path: join(files, 'folder.png') } },
    { id: 'edit-image', name: 'Write', kind: 'file_write', input: { file_path: join(files, 'generated.png') } },
    { id: 'generate-unsaved', name: 'GenerateImage', kind: 'other', input: { prompt: 'nothing saved' } },
  ]
  const sent = await runtime.sendTurn({ sessionId: started.session.sessionId, message: JSON.stringify(steps) })
  assert.ok(sent.ok)
  await runtime.flushTranscripts()

  const devices = createTailnetDeviceStore({ resolveUserDataDir: () => devicesDir })
  server = createTailnetGatewayServer({
    bindAddress: '127.0.0.1',
    port: 0,
    serverName: 'sprintengine-studio',
    serverVersion: '9.9.9',
    resolveTools: () => [],
    isMutation: () => false,
    devices,
    conversations: host,
    peers: createTailnetPeerResolver({ runWhois: async () => null }),
  })
  await server.start()
  port = server.address()!.port
  const pair = async (scopes: TailnetScope[]): Promise<string> => {
    const offer = devices.offerPairing({ scopes })
    const answer = await get(TAILNET_PAIR_PATH, {
      method: 'POST',
      body: { pairingToken: offer.token, deviceName: 'android-phone' },
    })
    assert.equal(answer.status, 200)
    return (JSON.parse(answer.body.toString('utf8')) as { deviceToken: string }).deviceToken
  }
  reader = await pair(['conversation:read'])
  noConversations = await pair(TAILNET_SCOPES.filter((scope) => !scope.startsWith('conversation:')))
})

afterAll(async () => {
  await server?.stop()
  await runtime?.shutdown()
  for (const dir of [workspaceRoot, devicesDir, files]) if (dir) rmSync(dir, { recursive: true, force: true })
})

type Answer = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }

function get(path: string, options: { token?: string; method?: string; body?: unknown } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path,
        agent: false,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }),
        )
      },
    )
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

function imagePath(toolUseId: string, extra: Record<string, string> = {}, key = { workspaceId, agentId }): string {
  const query = new URLSearchParams({ ...key, toolUseId, ...extra })
  return `${TAILNET_CONVERSATION_IMAGE_PATH}?${query.toString()}`
}

function errorOf(answer: Answer): { code: string; message: string } {
  assert.equal(answer.headers['content-type'], 'application/json; charset=utf-8')
  return (JSON.parse(answer.body.toString('utf8')) as { error: { code: string; message: string } }).error
}

test('a generated picture is served as the bytes on disk, under the path its last announcement named', async () => {
  const answer = await get(imagePath('generate'), { token: reader })
  assert.equal(answer.status, 200)
  assert.equal(answer.headers['content-type'], 'image/png')
  assert.equal(answer.headers['content-length'], String(PNG.length))
  assert.equal(answer.headers['cache-control'], 'private, max-age=86400')
  assert.deepEqual(answer.body, PNG)
})

test('a picture a step read is served under the type its bytes say, not its name', async () => {
  const answer = await get(imagePath('read-image'), { token: reader })
  assert.equal(answer.status, 200)
  assert.equal(answer.headers['content-type'], 'image/jpeg', 'screenshot.png holds a JPEG')
  assert.deepEqual(answer.body, JPEG)
})

test('a relative path names a file in the chat’s folder, and a link is followed to the picture it names', async () => {
  const relative = await get(imagePath('read-relative'), { token: reader })
  assert.equal(relative.status, 200)
  assert.equal(relative.headers['content-type'], 'image/gif')
  assert.deepEqual(relative.body, GIF)
  const linked = await get(imagePath('read-linked'), { token: reader })
  assert.equal(linked.status, 200)
  assert.equal(linked.headers['content-type'], 'image/webp')
  assert.deepEqual(linked.body, WEBP)
})

test('a path in the query is never read: the step names the file', async () => {
  const answer = await get(imagePath('generate', { path: join(files, 'screenshot.png') }), { token: reader })
  assert.equal(answer.status, 200)
  assert.deepEqual(answer.body, PNG, 'the step’s own picture, not the one the query named')
  const unknown = await get(imagePath('no-such-step', { path: join(files, 'generated.png') }), { token: reader })
  assert.equal(unknown.status, 404)
  assert.equal(errorOf(unknown).code, 'unknown_image')
})

test('without a device token the route is refused, and without a conversation grant it says which scope', async () => {
  const anonymous = await get(imagePath('generate'))
  assert.equal(anonymous.status, 401)
  assert.equal(errorOf(anonymous).code, 'unauthorized')
  const wrongScope = await get(imagePath('generate'), { token: noConversations })
  assert.equal(wrongScope.status, 403)
  assert.equal(errorOf(wrongScope).code, 'tailnet_scope_required')
})

test('a request that does not name the chat and the step is refused as invalid', async () => {
  const answer = await get(`${TAILNET_CONVERSATION_IMAGE_PATH}?workspaceId=${workspaceId}&agentId=${agentId}`, {
    token: reader,
  })
  assert.equal(answer.status, 400)
  assert.equal(errorOf(answer).code, 'invalid_arguments')
})

test('a chat this machine does not have is an unknown conversation', async () => {
  for (const key of [
    { workspaceId: 'elsewhere', agentId },
    { workspaceId, agentId: 'nobody' },
  ]) {
    const answer = await get(imagePath('generate', {}, key), { token: reader })
    assert.equal(answer.status, 404)
    assert.equal(errorOf(answer).code, 'unknown_conversation')
  }
})

test('a step that is not there, shows no picture, or saved none is an unknown image', async () => {
  for (const toolUseId of ['no-such-step', 'read-text', 'edit-image', 'generate-unsaved']) {
    const answer = await get(imagePath(toolUseId), { token: reader })
    assert.equal(answer.status, 404, toolUseId)
    assert.equal(errorOf(answer).code, 'unknown_image', toolUseId)
  }
})

test('a picture that is gone, or a path that is not a file, is an unknown image', async () => {
  for (const toolUseId of ['read-missing', 'read-folder']) {
    const answer = await get(imagePath(toolUseId), { token: reader })
    assert.equal(answer.status, 404, toolUseId)
    assert.equal(errorOf(answer).code, 'unknown_image', toolUseId)
  }
})

test('a file named like a picture whose bytes are not one is refused as not an image', async () => {
  const answer = await get(imagePath('read-words'), { token: reader })
  assert.equal(answer.status, 415)
  assert.equal(errorOf(answer).code, 'not_an_image')
})

test('a picture over the ceiling is refused as too large', async () => {
  const answer = await get(imagePath('read-huge'), { token: reader })
  assert.equal(answer.status, 413)
  assert.equal(errorOf(answer).code, 'image_too_large')
})

test('health and identity advertise the capability', async () => {
  assert.ok(TAILNET_CAPABILITIES.includes('conversation-images'))
  const health = JSON.parse((await get(TAILNET_HEALTH_PATH)).body.toString('utf8')) as { capabilities: string[] }
  assert.ok(health.capabilities.includes('conversation-images'))
  const identity = await get(TAILNET_IDENTITY_PATH, { token: reader })
  assert.ok(
    (JSON.parse(identity.body.toString('utf8')) as { capabilities: string[] }).capabilities.includes(
      'conversation-images',
    ),
  )
})

test('the four formats are told apart by their first bytes, and nothing else passes', () => {
  assert.equal(sniffConversationImage(PNG), 'image/png')
  assert.equal(sniffConversationImage(JPEG), 'image/jpeg')
  assert.equal(sniffConversationImage(WEBP), 'image/webp')
  assert.equal(sniffConversationImage(GIF), 'image/gif')
  assert.equal(sniffConversationImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null)
  assert.equal(sniffConversationImage(Buffer.from('BM')), null, 'a bitmap is not one of the four')
  assert.equal(sniffConversationImage(Buffer.alloc(0)), null)
})

test('only a generated picture or a read of a picture names a file', () => {
  assert.equal(
    conversationImagePathOf({ name: 'GenerateImage', kind: 'other', input: { path: '/tmp/a.png' } }),
    '/tmp/a.png',
  )
  assert.equal(
    conversationImagePathOf({ name: 'Read', kind: undefined, input: { file_path: '/tmp/a.jpg' } }),
    '/tmp/a.jpg',
  )
  assert.equal(conversationImagePathOf({ name: 'Read', kind: 'file_read', input: { file_path: '/tmp/a.ts' } }), null)
  assert.equal(conversationImagePathOf({ name: 'Bash', kind: 'command', input: { path: '/tmp/a.png' } }), null)
  assert.equal(conversationImagePathOf({ name: 'Write', kind: 'file_write', input: { file_path: '/tmp/a.png' } }), null)
  assert.equal(conversationImagePathOf({ name: 'GenerateImage', kind: 'other', input: {} }), null)
  assert.equal(conversationImagePathOf({ name: 'GenerateImage', kind: 'other', input: 'not an object' }), null)
})
