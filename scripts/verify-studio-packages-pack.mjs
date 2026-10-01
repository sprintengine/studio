// Exercise the Studio protocol's and the agent SDK's tarballs the way a third
// party installs them: packed, installed together with the conversation
// protocol's tarball they depend on (no registry, no network), and loaded from
// both module systems, with Node16 declarations checked by a consumer that
// imports them by name.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const fixture = mkdtempSync(join(tmpdir(), 'studio-packages-pack-'))
const require = createRequire(import.meta.url)
const compiler = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc')
const env = {
  ...process.env,
  PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
}
const run = (command, args, cwd = fixture) => execFileSync(command, args, { cwd, env, stdio: 'pipe' }).toString('utf8')

/** Build and pack one package directory, returning the tarball's path. */
function pack(name) {
  const packageDir = join(root, 'packages', name)
  run(process.execPath, ['build.mjs'], packageDir)
  const packed = JSON.parse(
    run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', fixture], packageDir),
  )
  return join(fixture, packed[0].filename)
}

/** Both module systems' view of an installed package's entry, by name. */
async function load(name, entry = '.') {
  const installed = join(fixture, 'node_modules', '@sprintengine', name)
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  const fixtureRequire = createRequire(join(fixture, 'package.json'))
  const esm = await import(pathToFileURL(join(installed, manifest.exports[entry].import.default)).href)
  return [esm, fixtureRequire(entry === '.' ? `@sprintengine/${name}` : `@sprintengine/${name}/${entry.slice(2)}`)]
}

try {
  const tarballs = ['conversation-protocol', 'studio-protocol', 'agent-sdk'].map(pack)
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ private: true }))
  run('npm', ['install', '--ignore-scripts', '--no-save', '--no-package-lock', '--no-audit', '--no-fund', ...tarballs])

  for (const loaded of await load('studio-protocol')) {
    assert.equal(loaded.STUDIO_PROTOCOL_VERSION, 1)
    // The conversation contract arrives through the dependency, not a copy.
    assert.equal(loaded.CONVERSATION_CAPABILITY, 'conversations')
    assert.equal(loaded.parseConversationClientMessage({ type: 'hello', requestId: 'h-1' }).type, 'hello')
    assert.deepEqual(
      loaded.parseStudioMethodParams('conversation.send', {
        key: { workspaceId: 'w', agentId: 'a' },
        commandId: 'c-1',
        message: 'hi',
      }),
      { ok: true, params: { key: { workspaceId: 'w', agentId: 'a' }, commandId: 'c-1', message: 'hi' } },
    )
    assert.equal(loaded.STUDIO_METHODS['conversation.create'].scope, 'conversation:create')
    assert.equal(
      loaded.parseStudioServerFrame({ t: 'frame', sub: 's', frame: { type: 'synchronized', seq: 1, generation: 'g' } })
        .frame.seq,
      1,
    )
  }
  for (const loaded of await load('agent-sdk')) {
    assert.equal(typeof loaded.connect, 'function')
    assert.equal(typeof loaded.fromModuleConversationService, 'function')
    // The protocol arrives through the dependency, and the client's error is the class.
    assert.equal(loaded.STUDIO_PROTOCOL_VERSION, 1)
    assert.equal(new loaded.StudioError('busy', 'Busy.').code, 'busy')
    assert.equal(
      loaded.approvalRequestOf({ type: 'approval_requested', payload: { requestId: 'r', kind: 'plan', plan: 'p' } })
        .kind,
      'plan',
    )
  }
  for (const loaded of await load('agent-sdk', './node')) {
    assert.equal(typeof loaded.connectToStudio, 'function')
    assert.equal(
      loaded.studioDataDir({ env: {}, platform: 'darwin', home: '/Users/dev' }),
      '/Users/dev/Library/Application Support/SprintEngine Studio',
    )
  }
  const sdkSource = readFileSync(
    join(fixture, 'node_modules', '@sprintengine', 'agent-sdk', 'dist', 'esm', 'protocol.js'),
    'utf8',
  )
  assert.match(sdkSource, /@sprintengine\/studio-protocol/)
  const studioSource = readFileSync(
    join(fixture, 'node_modules', '@sprintengine', 'studio-protocol', 'dist', 'esm', 'conversation.js'),
    'utf8',
  )
  assert.match(studioSource, /@sprintengine\/conversation-protocol/)

  const consumer = `import { parseStudioServerFrame, STUDIO_METHODS, parseConversationServerFrame, type StudioMethodResult, type StudioWelcomeFrame, type ConversationEvent, type ConversationThread } from '@sprintengine/studio-protocol'
const listed: StudioMethodResult<'conversation.list'> = { conversations: [] as ConversationThread[] }
const welcome: StudioWelcomeFrame | null = null
const event: ConversationEvent | null = null
console.log(parseStudioServerFrame({}), STUDIO_METHODS['conversation.list'].scope, parseConversationServerFrame({}), listed, welcome, event)
import { connect, approvalRequestOf, StudioError, type StudioClient, type Conversation, type ConversationEventStream } from '@sprintengine/agent-sdk'
import { connectToStudio, socketTransport } from '@sprintengine/agent-sdk/node'
const client: StudioClient | null = null
const conversation: Conversation | null = null
const stream: ConversationEventStream | null = null
console.log(connect, approvalRequestOf, new StudioError('x', 'y').code, client, conversation, stream, connectToStudio, socketTransport)
`
  for (const extension of ['cts', 'mts']) writeFileSync(join(fixture, `consumer.${extension}`), consumer)
  writeFileSync(
    join(fixture, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'Node16',
        moduleResolution: 'Node16',
        strict: true,
        noEmit: true,
        types: ['node'],
        typeRoots: [join(root, 'node_modules', '@types')],
      },
      include: ['consumer.cts', 'consumer.mts'],
    }),
  )
  run(process.execPath, [compiler, '-p', join(fixture, 'tsconfig.json')])
  console.log('studio-protocol and agent-sdk pack verification passed (ESM, CommonJS, Node16 declarations)')
} finally {
  // Only the directory created above is removed, never a caller-owned path.
  rmSync(fixture, { recursive: true, force: true })
}
