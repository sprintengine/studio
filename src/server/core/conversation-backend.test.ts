import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { test } from 'vitest'

// Everything that drives chats takes a `ConversationBackend`, so a later phase
// can route a workspace's chats to another server without touching any of it.
// A caller that names the runtime class instead would keep working, and would
// silently stay on this machine's runtime once routing exists. So the class is
// named only where it is constructed or implemented, and a new caller fails
// here rather than in review.

const ROOT = join(__dirname, '..', '..', '..')
const RUNTIME = resolve(ROOT, 'src/main/conversation-runtime.ts')

/** The files that may name the runtime class, and why. */
const MAY_NAME_THE_RUNTIME: Record<string, string> = {
  'src/main/conversation-runtime.ts': 'the runtime itself',
  'src/server/core/conversation-backend.ts': 'picks the backend out of it',
  'src/server/core/studio-core.ts': 'constructs the one runtime and hands out its backend',
  'src/main/ipc/conversation-ipc.ts': 'builds a stand-alone runtime only when it is handed none (its own tests)',
}

function sourceFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(join(ROOT, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name !== '__fixtures__' && entry.name !== 'node_modules') files.push(...sourceFiles(path))
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|test-helper|d)\.tsx?$/.test(entry.name)) {
      files.push(path)
    }
  }
  return files
}

const IMPORT = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/g

function namesTheRuntime(file: string): boolean {
  const source = readFileSync(join(ROOT, file), 'utf8')
  for (const match of source.matchAll(IMPORT)) {
    const specifier = match[3]!
    if (!specifier.startsWith('.')) continue
    const target = resolve(ROOT, dirname(file), specifier)
    if (`${target}.ts` !== RUNTIME && target !== RUNTIME) continue
    const names = match[2]!.split(',').map((name) => name.replace(/^\s*type\s+/, '').trim())
    if (names.some((name) => name === 'ConversationRuntime' || name.startsWith('ConversationRuntime as '))) return true
  }
  return false
}

test('only the runtime and the code that constructs it name the ConversationRuntime class', () => {
  const offenders = [...sourceFiles('src'), ...sourceFiles('packages')]
    .filter((file) => !Object.hasOwn(MAY_NAME_THE_RUNTIME, file))
    .filter(namesTheRuntime)
    .map((file) => relative(ROOT, join(ROOT, file)))
  assert.deepEqual(
    offenders,
    [],
    'Take a ConversationBackend (src/server/core/conversation-backend.ts) instead of the runtime class.',
  )
})

test('the scan sees an import of the runtime class where there is one', () => {
  assert.equal(namesTheRuntime('src/server/core/studio-core.ts'), true)
  assert.equal(namesTheRuntime('src/main/conversation-session-api.ts'), false)
})
