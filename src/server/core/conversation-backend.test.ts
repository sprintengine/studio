import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'vitest'

// Everything that drives chats takes a `ConversationBackend`, so a later phase
// can route a workspace's chats to another server without touching any of it.
// A caller that names the runtime class instead would keep working, and would
// silently stay on this machine's runtime once routing exists. So the runtime
// is named only where it is constructed or implemented, by an import, a type,
// `services.conversationRuntime` or anything else, and a new caller fails here
// rather than in review.

const ROOT = join(__dirname, '..', '..', '..')

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

// Comments may talk about the runtime; code may not name it. Block comments,
// and line comments that do not sit inside a string or a URL, are dropped
// before the scan.
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g
const LINE_COMMENT = /(^|[^:'"`\\])\/\/.*$/gm
// The class by any route (an import, a type, `new`), and the services member
// that used to carry it (`services.conversationRuntime`, a `conversationRuntime:`
// key). `AgentConversationRuntime` and `ConversationRuntimeToken` are other names.
const NAMES_THE_RUNTIME = /\b(?:ConversationRuntime|conversationRuntime)\b/

/** The first line of `source` that names the runtime, with comments dropped; null when none does. */
function runtimeReference(source: string): string | null {
  const code = source.replace(BLOCK_COMMENT, '').replace(LINE_COMMENT, '$1')
  return (
    code
      .split('\n')
      .find((line) => NAMES_THE_RUNTIME.test(line))
      ?.trim() ?? null
  )
}

test('only the runtime and the code that constructs it name the runtime', () => {
  const offenders = [...sourceFiles('src'), ...sourceFiles('packages')]
    .filter((file) => !Object.hasOwn(MAY_NAME_THE_RUNTIME, file))
    .flatMap((file) => {
      const line = runtimeReference(readFileSync(join(ROOT, file), 'utf8'))
      return line === null ? [] : [`${relative(ROOT, join(ROOT, file))}: ${line}`]
    })
  assert.deepEqual(
    offenders,
    [],
    "Take a ConversationBackend (src/server/core/conversation-backend.ts), or the core's conversationOwner for flush, shutdown and the idle threshold, instead of the runtime.",
  )
})

test('the scan sees the runtime named by an import, a type, a property or a key, and not in a comment', () => {
  assert.notEqual(runtimeReference("import { ConversationRuntime } from './conversation-runtime'"), null)
  assert.notEqual(runtimeReference('let runtime: ConversationRuntime'), null)
  assert.notEqual(runtimeReference('services.conversationRuntime.onEvent(listener)'), null)
  assert.notEqual(runtimeReference('{ conversationRuntime: services.runtime }'), null)
  assert.equal(runtimeReference('// wraps a real ConversationRuntime session'), null)
  assert.equal(runtimeReference('/* the ConversationRuntime */ const a = 1'), null)
  assert.equal(runtimeReference("const url = 'https://example.com' // ConversationRuntime"), null)
  assert.equal(runtimeReference('type A = AgentConversationRuntime | typeof ConversationRuntimeToken'), null)
})
