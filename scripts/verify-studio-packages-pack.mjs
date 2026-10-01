// Exercise the Studio protocol's tarball the way a third party installs it:
// packed, installed beside the conversation protocol's tarball it depends on
// (no registry, no network), and loaded from both module systems, with Node16
// declarations checked by a consumer that imports it by name.
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

/** Both module systems' view of an installed package, by name. */
async function load(name) {
  const installed = join(fixture, 'node_modules', '@sprintengine', name)
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  const fixtureRequire = createRequire(join(fixture, 'package.json'))
  const esm = await import(pathToFileURL(join(installed, manifest.exports['.'].import.default)).href)
  return [esm, fixtureRequire(`@sprintengine/${name}`)]
}

try {
  const tarballs = ['conversation-protocol', 'studio-protocol'].map(pack)
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
        types: [],
      },
      include: ['consumer.cts', 'consumer.mts'],
    }),
  )
  run(process.execPath, [compiler, '-p', join(fixture, 'tsconfig.json')])
  console.log('studio-protocol pack verification passed (ESM, CommonJS, Node16 declarations)')
} finally {
  // Only the directory created above is removed, never a caller-owned path.
  rmSync(fixture, { recursive: true, force: true })
}
