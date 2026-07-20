import assert from 'node:assert/strict'

import {
  backlogMockupResolutionCandidates,
  collectBacklogMockups,
  collectDanglingMockups,
  detectBacklogMockupReferences,
  parseBacklogMockups,
} from './backlogMockups'

let failures = 0
function run(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

// ---- parseBacklogMockups ---------------------------------------------------

run('parseBacklogMockups splits the CSV scalar into a clean project-relative list', () => {
  assert.deepEqual(
    parseBacklogMockups('backlog/mockups/a.html, backlog/mockups/b.html'),
    ['backlog/mockups/a.html', 'backlog/mockups/b.html'],
  )
})

run('parseBacklogMockups is empty for absent/blank input', () => {
  assert.deepEqual(parseBacklogMockups(undefined), [])
  assert.deepEqual(parseBacklogMockups(''), [])
  assert.deepEqual(parseBacklogMockups('   ,  , '), [])
})

run('parseBacklogMockups normalizes backslashes and dedupes preserving first-seen order', () => {
  assert.deepEqual(
    parseBacklogMockups('mockups\\x.html, mockups/x.html, mockups/y.html'),
    ['mockups/x.html', 'mockups/y.html'],
  )
})

run('parseBacklogMockups drops absolute paths, `..` escapes, and URLs', () => {
  assert.deepEqual(parseBacklogMockups('/etc/passwd.html'), [])
  assert.deepEqual(parseBacklogMockups('../secret/x.html'), [])
  assert.deepEqual(parseBacklogMockups('mockups/../../x.html'), [])
  assert.deepEqual(parseBacklogMockups('https://example.com/x.html'), [])
  assert.deepEqual(parseBacklogMockups('C:\\Users\\x.html'), [])
  // A valid entry alongside invalid ones survives; the invalid ones are dropped.
  assert.deepEqual(parseBacklogMockups('mockups/ok.html, /abs.html, ../up.html'), ['mockups/ok.html'])
})

// ---- detectBacklogMockupReferences -----------------------------------------

run('detectBacklogMockupReferences resolves ../mockups links relative to the item dir', () => {
  const body = 'Mockup: [preview](../mockups/2026-07-06-foo.html)\n\nMore text.'
  assert.deepEqual(
    detectBacklogMockupReferences(body, 'backlog/2026-07-06-item.md'),
    ['mockups/2026-07-06-foo.html'],
  )
})

run('detectBacklogMockupReferences keeps a bare root-relative backtick path as-is', () => {
  const body = 'See `backlog/mockups/x.html` and `mockups/y.html`.'
  assert.deepEqual(
    detectBacklogMockupReferences(body, 'backlog/item.md'),
    ['backlog/mockups/x.html', 'mockups/y.html'],
  )
})

run('detectBacklogMockupReferences finds two references shaped like a real prose-only item', () => {
  const body = [
    '# Some feature',
    '',
    'Mockup: [main](../mockups/main.html)',
    '',
    'Reference: `mockups/detail.html`',
  ].join('\n')
  const refs = detectBacklogMockupReferences(body, 'backlog/2026-07-06-inset-agent-identity.md')
  assert.deepEqual(refs, ['mockups/main.html', 'mockups/detail.html'])
})

run('detectBacklogMockupReferences skips http(s), absolute, and non-html refs', () => {
  const body = [
    '[external](https://example.com/x.html)',
    '[abs](/var/tmp/y.html)',
    '[doc](../mockups/notes.md)',
    '[img](../mockups/pic.png)',
  ].join('\n')
  assert.deepEqual(detectBacklogMockupReferences(body, 'backlog/item.md'), [])
})

run('detectBacklogMockupReferences ignores #fragment/?query tails when testing the extension', () => {
  const body = '[a](../mockups/x.html#top) and [b](../mockups/z.html?v=2)'
  assert.deepEqual(
    detectBacklogMockupReferences(body, 'backlog/item.md'),
    ['mockups/x.html', 'mockups/z.html'],
  )
})

run('detectBacklogMockupReferences dedupes a file linked twice', () => {
  const body = '[a](../mockups/x.html) then again `mockups/x.html`'
  assert.deepEqual(detectBacklogMockupReferences(body, 'backlog/item.md'), ['mockups/x.html'])
})

// ---- collectBacklogMockups -------------------------------------------------

run('collectBacklogMockups lists attached entries first, then non-duplicate detected ones', () => {
  const entries = collectBacklogMockups({
    mockups: ['backlog/mockups/a.html'],
    relativePath: 'backlog/item.md',
    sourceContent: '[a](../mockups/a.html)\n[b](../mockups/b.html)',
  })
  assert.deepEqual(entries, [
    { path: 'backlog/mockups/a.html', source: 'attached' },
    { path: 'mockups/b.html', source: 'detected' },
  ])
})

run('collectBacklogMockups does not double-list a file that is both attached and detected', () => {
  const entries = collectBacklogMockups({
    mockups: ['mockups/x.html'],
    relativePath: 'backlog/item.md',
    sourceContent: 'See `mockups/x.html`',
  })
  assert.deepEqual(entries, [{ path: 'mockups/x.html', source: 'attached' }])
})

run('collectBacklogMockups handles an item with no mockups and no references', () => {
  assert.deepEqual(
    collectBacklogMockups({ mockups: undefined, relativePath: 'backlog/item.md', sourceContent: '# Just text' }),
    [],
  )
})

// ---- backlogMockupResolutionCandidates -------------------------------------

run('backlogMockupResolutionCandidates probes the ref as-authored, then under backlog/', () => {
  assert.deepEqual(backlogMockupResolutionCandidates('mockups/x.html'), [
    'mockups/x.html',
    'backlog/mockups/x.html',
  ])
})

run('backlogMockupResolutionCandidates does not double-prefix an already backlog/-relative ref', () => {
  assert.deepEqual(backlogMockupResolutionCandidates('backlog/mockups/x.html'), [
    'backlog/mockups/x.html',
  ])
})

run('backlogMockupResolutionCandidates is empty for an empty ref', () => {
  assert.deepEqual(backlogMockupResolutionCandidates(''), [])
})

// ---- collectDanglingMockups (async, tolerant both-roots existence) ---------

async function runAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

// An existence probe backed by a fixed set of present root-relative paths.
const existsIn = (present: readonly string[]) => async (relativePath: string) =>
  present.includes(relativePath)

async function collectDanglingMockupsTests(): Promise<void> {
  await runAsync('collectDanglingMockups flags an attached ref that resolves under neither root', async () => {
    assert.deepEqual(
      await collectDanglingMockups(
        { mockups: ['mockups/missing.html'], relativePath: 'backlog/item.md', sourceContent: '# t' },
        existsIn([]),
      ),
      ['mockups/missing.html'],
    )
  })

  await runAsync('collectDanglingMockups resolves a backlog/-relative ref authored WITHOUT the prefix', async () => {
    // The exact failure MC-1697 fixes: `mockups/x.html` authored, file at
    // `backlog/mockups/x.html`. The backlog/ candidate resolves → not dangling.
    assert.deepEqual(
      await collectDanglingMockups(
        { mockups: ['mockups/x.html'], relativePath: 'backlog/item.md', sourceContent: '# t' },
        existsIn(['backlog/mockups/x.html']),
      ),
      [],
    )
  })

  await runAsync('collectDanglingMockups resolves a root-relative ref present as authored', async () => {
    assert.deepEqual(
      await collectDanglingMockups(
        { mockups: ['backlog/mockups/x.html'], relativePath: 'backlog/item.md', sourceContent: '# t' },
        existsIn(['backlog/mockups/x.html']),
      ),
      [],
    )
  })

  await runAsync('collectDanglingMockups flags a body-detected mockup mention that dangles', async () => {
    assert.deepEqual(
      await collectDanglingMockups(
        { mockups: undefined, relativePath: 'backlog/item.md', sourceContent: 'Mockup: [x](mockups/gone.html)' },
        existsIn([]),
      ),
      ['mockups/gone.html'],
    )
  })

  await runAsync('collectDanglingMockups returns nothing when the item names no mockup', async () => {
    assert.deepEqual(
      await collectDanglingMockups(
        { mockups: undefined, relativePath: 'backlog/item.md', sourceContent: '# Just text' },
        existsIn([]),
      ),
      [],
    )
  })
}

async function main(): Promise<void> {
  await collectDanglingMockupsTests()
  if (failures > 0) {
    console.error(`backlogMockups.test.ts: ${failures} failing`)
    process.exit(1)
  }
  console.log('backlogMockups.test.ts: ok')
}

void main()
