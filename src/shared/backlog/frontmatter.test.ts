import assert from 'node:assert/strict'
import { type Dirent, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseBacklogFrontmatter,
  serializeBacklogFrontmatterFields,
} from './frontmatter'

const tests: Array<{ name: string; body: () => void }> = []

function run(name: string, body: () => void): void {
  tests.push({ name, body })
}

// Every *.md file under backlog/, recursively (including archived/ and any
// epics/ subtree) — the corpus the round-trip property tests run against.
function collectBacklogMarkdown(dir: string, out: string[]): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectBacklogMarkdown(full, out)
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(full)
  }
  return out
}

const backlogRoot = join(process.cwd(), 'backlog')
const fixtureFiles = collectBacklogMarkdown(backlogRoot, [])

// A top-level key guaranteed absent from any real backlog file, so set→clear is
// a pure inverse and an append never collides with an existing line.
const PROBE_KEY = 'zz-roundtrip-probe'

function bodyOf(content: string): string {
  return parseBacklogFrontmatter(content).body
}

function topLevelKeyOrder(content: string): string[] {
  const fields = parseBacklogFrontmatter(content).fields
  return Object.keys(fields).filter((key) => !key.includes('.'))
}

run('every repo backlog file is available as a round-trip fixture', () => {
  assert.ok(fixtureFiles.length > 0, `expected backlog/*.md fixtures under ${backlogRoot}`)
})

run('property: set then clear an absent key returns byte-identical content', () => {
  for (const path of fixtureFiles) {
    const original = readFileSync(path, 'utf8')
    const fields = parseBacklogFrontmatter(original).fields
    assert.ok(!(PROBE_KEY in fields), `${path} unexpectedly already defines ${PROBE_KEY}`)
    const set = serializeBacklogFrontmatterFields(original, { [PROBE_KEY]: 'probe-value' })
    const cleared = serializeBacklogFrontmatterFields(set, { [PROBE_KEY]: null })
    assert.equal(cleared, original, `set→clear not byte-identical for ${path}`)
  }
})

run('property: writing a field preserves the body and unknown keys + order', () => {
  for (const path of fixtureFiles) {
    const original = readFileSync(path, 'utf8')
    const beforeBody = bodyOf(original)
    const beforeKeys = topLevelKeyOrder(original)
    // Set the probe field; every pre-existing key must remain, in the same order,
    // and the document body after the frontmatter block must not move a byte.
    const updated = serializeBacklogFrontmatterFields(original, { [PROBE_KEY]: 'x' })
    assert.equal(bodyOf(updated), beforeBody, `body changed for ${path}`)
    const afterKeys = topLevelKeyOrder(updated).filter((key) => key !== PROBE_KEY)
    assert.deepEqual(afterKeys, beforeKeys, `unknown-key order changed for ${path}`)
  }
})

run('parse splits frontmatter fields from the document body', () => {
  const { body, fields } = parseBacklogFrontmatter('---\ntype: feature\nstatus: ready\n---\n# Title\nBody.')
  assert.equal(fields.type, 'feature')
  assert.equal(fields.status, 'ready')
  assert.equal(body, '# Title\nBody.')
})

run('parse keeps a nested section as section.key entries (backward compat read)', () => {
  const { fields } = parseBacklogFrontmatter('---\nbacklog:\n  planKind: product_plan\n  size: l\n---\n# T')
  assert.equal(fields['backlog.plankind'], 'product_plan')
  assert.equal(fields['backlog.size'], 'l')
})

run('parse returns the whole content as body when there is no frontmatter', () => {
  const { body, fields } = parseBacklogFrontmatter('# Just a note\nNo frontmatter here.')
  assert.deepEqual(fields, {})
  assert.equal(body, '# Just a note\nNo frontmatter here.')
})

run('set appends a new key at the end of the frontmatter block, body untouched', () => {
  const out = serializeBacklogFrontmatterFields('---\ntype: feature\n---\n# Title\nBody.', { epic: 'auth-revamp' })
  assert.equal(out, '---\ntype: feature\nepic: auth-revamp\n---\n# Title\nBody.')
})

run('set replaces an existing value in place, preserving other lines and order', () => {
  const out = serializeBacklogFrontmatterFields(
    '---\ntype: feature\nstatus: idea\ndifficulty: m\n---\nbody',
    { status: 'ready' },
  )
  assert.equal(out, '---\ntype: feature\nstatus: ready\ndifficulty: m\n---\nbody')
})

run('clear removes only the targeted line and keeps the rest in order', () => {
  const out = serializeBacklogFrontmatterFields(
    '---\ntype: feature\nrisk: high\nstatus: ready\n---\nbody',
    { risk: null },
  )
  assert.equal(out, '---\ntype: feature\nstatus: ready\n---\nbody')
})

run('clearing an absent key is a no-op', () => {
  const original = '---\ntype: feature\n---\nbody'
  assert.equal(serializeBacklogFrontmatterFields(original, { epic: null }), original)
})

run('no updates returns the content unchanged', () => {
  const original = '---\ntype: feature\n---\nbody'
  assert.equal(serializeBacklogFrontmatterFields(original, {}), original)
})

run('setting on a file with no frontmatter creates a block above the body', () => {
  const out = serializeBacklogFrontmatterFields('# Title\nBody.', { type: 'feature', status: 'idea' })
  assert.equal(out, '---\ntype: feature\nstatus: idea\n---\n# Title\nBody.')
})

run('clear-only on a file with no frontmatter never injects an empty block', () => {
  const original = '# Title\nBody.'
  assert.equal(serializeBacklogFrontmatterFields(original, { type: null }), original)
})

run('comments and blank lines inside the block are preserved', () => {
  const original = '---\n# a comment\ntype: feature\n\nstatus: ready\n---\nbody'
  const out = serializeBacklogFrontmatterFields(original, { epic: 'auth' })
  assert.equal(out, '---\n# a comment\ntype: feature\n\nstatus: ready\nepic: auth\n---\nbody')
})

run('a nested section block is left untouched when writing a top-level key', () => {
  const original = '---\ntype: feature\nbacklog:\n  size: l\n---\nbody'
  const out = serializeBacklogFrontmatterFields(original, { status: 'ready' })
  assert.equal(out, '---\ntype: feature\nbacklog:\n  size: l\nstatus: ready\n---\nbody')
})

run('values needing quoting are quoted; simple slugs and ISO timestamps are not', () => {
  assert.equal(
    serializeBacklogFrontmatterFields('---\ntype: feature\n---\nb', { updated: '2026-06-26T10:00:00Z' }),
    '---\ntype: feature\nupdated: 2026-06-26T10:00:00Z\n---\nb',
  )
  assert.equal(
    serializeBacklogFrontmatterFields('---\ntype: feature\n---\nb', { title: 'Fix: the bug' }),
    '---\ntype: feature\ntitle: "Fix: the bug"\n---\nb',
  )
  // A quoted value round-trips back to its bare form through the parser.
  const quoted = serializeBacklogFrontmatterFields('---\ntype: feature\n---\nb', { title: 'a "quote"' })
  assert.equal(parseBacklogFrontmatter(quoted).fields.title, 'a "quote"')
})

run('sec F1: a newline-bearing value cannot inject extra frontmatter keys', () => {
  const injection = 'idea\ntype: epic\norder: -999'
  const out = serializeBacklogFrontmatterFields('---\ntype: feature\n---\nbody', { status: injection })
  const fields = parseBacklogFrontmatter(out).fields
  // Only the intended keys exist; the crafted type/order lines did not become keys.
  assert.deepEqual(Object.keys(fields).sort(), ['status', 'type'])
  assert.equal(fields.type, 'feature')
  // The frontmatter block is a single status line (no spilled physical lines).
  assert.equal((out.match(/\nstatus:/g) || []).length, 1)
  assert.ok(!/\norder:/.test(out), 'no injected order line')
})

run('sec F1: embedded CR/LF round-trip without spilling, value flattened to one line', () => {
  for (const value of ['a\nb', 'a\r\nb', 'lead\n', '\ntrail']) {
    const out = serializeBacklogFrontmatterFields('---\ntype: feature\n---\nb', { note: value })
    const parsed = parseBacklogFrontmatter(out).fields
    assert.ok(!/[\r\n]/.test(parsed.note), `value still multi-line for ${JSON.stringify(value)}`)
    // Re-serializing the parsed value is stable (idempotent on already-flat input).
    const again = serializeBacklogFrontmatterFields('---\ntype: feature\n---\nb', { note: parsed.note })
    assert.equal(parseBacklogFrontmatter(again).fields.note, parsed.note)
  }
})

run('sec F2: an embedded-quote value that needs quoting round-trips exactly', () => {
  for (const value of ['Fix: "the bug"', '"already quoted"', 'a\\b "c"', 'trailing \\']) {
    const out = serializeBacklogFrontmatterFields('---\ntype: feature\n---\nb', { title: value })
    assert.equal(parseBacklogFrontmatter(out).fields.title, value, `no round-trip for ${JSON.stringify(value)}`)
  }
})

run('CRLF documents keep CRLF line endings and a byte-identical body', () => {
  const original = '---\r\ntype: feature\r\n---\r\n# Title\r\nBody.'
  const set = serializeBacklogFrontmatterFields(original, { status: 'ready' })
  assert.equal(set, '---\r\ntype: feature\r\nstatus: ready\r\n---\r\n# Title\r\nBody.')
  const roundtrip = serializeBacklogFrontmatterFields(
    serializeBacklogFrontmatterFields(original, { [PROBE_KEY]: 'x' }),
    { [PROBE_KEY]: null },
  )
  assert.equal(roundtrip, original)
})

function main(): void {
  for (const test of tests) {
    try {
      test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      console.error(`not ok - ${test.name}`)
      throw error
    }
  }
  console.log('frontmatter.test.ts: ok')
}

main()
