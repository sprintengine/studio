import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'vitest'

// The renderer document's Content-Security-Policy is the runtime half of "no
// code from a CDN": the bundle is built to need none, and this policy is what
// makes a remote script, worker or font fail instead of loading. Network
// requests are not code: a module calling a remote API over https or wss is
// allowed (owner ruling 2026-09-27). Every window that can show an editor is
// this document.

function policy(): Map<string, string[]> {
  const html = readFileSync(join(import.meta.dirname, 'index.html'), 'utf8')
  const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/?>/.exec(html)
  assert.ok(meta, 'index.html declares a Content-Security-Policy')
  const directives = new Map<string, string[]>()
  for (const part of meta[1]!.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/)
    if (name) directives.set(name, sources)
  }
  return directives
}

// What a local source looks like: a quoted keyword ('self', 'unsafe-inline', …)
// or one of the in-process schemes. Anything else — a scheme with a network
// behind it, a host, a wildcard — would let a remote origin in.
const LOCAL_SOURCE = /^('[a-z-]+'|blob:|data:|studio-module:)$/

test('scripts, workers and fonts may only come from the app itself', () => {
  const directives = policy()
  for (const name of ['script-src', 'worker-src', 'font-src']) {
    const sources = directives.get(name)
    assert.ok(sources && sources.length > 0, `${name} is declared, so it cannot fall back to "anything"`)
    const remote = sources.filter((source) => !LOCAL_SOURCE.test(source))
    assert.deepEqual(remote, [], `${name} allows no remote origin`)
    assert.ok(sources.includes("'self'"), `${name} still allows the bundle beside the document`)
  }
})

test('network requests may reach remote services only over https and wss', () => {
  const sources = policy().get('connect-src')
  assert.ok(sources?.includes("'self'"), 'the app can still reach its own origin')
  const remote = (sources ?? []).filter((source) => !LOCAL_SOURCE.test(source))
  assert.deepEqual(remote.sort(), ['https:', 'wss:'], 'encrypted schemes only: no plain http, no wildcard')
})

test('the policy does not allow evaluating strings as code', () => {
  const directives = policy()
  assert.ok(!directives.get('script-src')?.includes("'unsafe-eval'"), 'no eval, so fetched text can never become code')
  assert.deepEqual(directives.get('object-src'), ["'none'"])
})
