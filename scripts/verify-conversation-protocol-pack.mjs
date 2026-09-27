// Exercise the actual tarball in both module systems, including its portable
// presentation helpers. No registry publication or network dependency is needed.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const packageDir = join(root, 'packages', 'conversation-protocol')
const fixture = mkdtempSync(join(tmpdir(), 'conversation-protocol-pack-'))
const require = createRequire(import.meta.url)
const compiler = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc')
const env = {
  ...process.env,
  PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
}
const run = (command, args, cwd = fixture) => execFileSync(command, args, { cwd, env, stdio: 'pipe' }).toString('utf8')
try {
  run(process.execPath, ['build.mjs'], packageDir)
  const packed = JSON.parse(
    run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', fixture], packageDir),
  )
  const tarball = join(fixture, packed[0].filename)
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ private: true }))
  run('npm', ['install', '--ignore-scripts', '--no-save', '--no-package-lock', '--no-audit', '--no-fund', tarball])
  const installed = join(fixture, 'node_modules', '@sprintengine', 'conversation-protocol')
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  const fixtureRequire = createRequire(join(fixture, 'package.json'))
  const esm = await import(pathToFileURL(join(installed, manifest.exports['.'].import.default)).href)
  const cjs = fixtureRequire('@sprintengine/conversation-protocol')
  for (const loaded of [esm, cjs]) {
    assert.equal(loaded.CONVERSATION_CAPABILITY, 'conversations')
    assert.equal(loaded.parseConversationClientFrame({ type: 'list', requestId: 'list-1' }).requestId, 'list-1')
    assert.equal(loaded.inferConversationToolKind('Read'), 'file_read')
    assert.equal(
      loaded.presentToolItem({ name: 'Read', input: { path: '/workspace/notes.md' } }).title,
      'Read notes.md',
    )
    assert.equal(loaded.summarizeToolGroup([{ name: 'Read' }]), 'Read 1 file')
    assert.equal(loaded.CONVERSATION_MODELS_CAPABILITY, 'conversation-models')
    assert.deepEqual(
      loaded.parseConversationClientFrame({
        type: 'command',
        commandId: 'c-1',
        command: { kind: 'setModel', modelId: 'm' },
      }).command,
      { kind: 'setModel', modelId: 'm' },
    )
    assert.deepEqual(
      loaded.parseConversationWireModels({
        cli: 'claude-code',
        cliLabel: 'Claude Code',
        liveModelSwitch: true,
        options: [{ id: 'm', label: 'Model M' }],
      }).options,
      [{ id: 'm', label: 'Model M' }],
    )
  }
  const consumer = `import { presentToolItem, parseConversationClientFrame, parseConversationWireModels, type ConversationClientFrame, type ConversationToolKind, type ConversationWireModels } from '@sprintengine/conversation-protocol'
const kind: ConversationToolKind = 'file_read'
const frame: ConversationClientFrame | null = parseConversationClientFrame({ type: 'list', requestId: 'list-1' })
const models: ConversationWireModels | null = parseConversationWireModels(null)
console.log(presentToolItem({ name: 'Read', kind }), frame, models)
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
  console.log('conversation-protocol pack verification passed (ESM, CommonJS, Node16 declarations)')
} finally {
  // Only the directory created above is removed, never a caller-owned path.
  rmSync(fixture, { recursive: true, force: true })
}
