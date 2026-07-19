import assert from 'node:assert/strict'
import { mockupSourceDocFromMarkdown, resolveSprintEngineMockupBundleItems } from './sprintengineMockupSources'

// A reader over a fixed absolute-path → content map; anything else throws like
// a real readfile on a missing path.
function readerOver(files: Record<string, string>): (absolutePath: string) => Promise<string> {
  return async (absolutePath: string) => {
    const content = files[absolutePath]
    if (content === undefined) throw new Error(`ENOENT: ${absolutePath}`)
    return content
  }
}

async function testAttachedMockupResolvesToBundleItem(): Promise<void> {
  const items = await resolveSprintEngineMockupBundleItems({
    docs: [{
      mockups: ['backlog/mockups/checkout.html'],
      sourceContent: '# Checkout',
      relativePath: 'backlog/checkout.md',
    }],
    folderPath: '/repo',
    readFile: readerOver({ '/repo/backlog/mockups/checkout.html': '<h1>Checkout</h1>' }),
  })

  assert.deepEqual(items, [{
    kind: 'html_mockup',
    sourcePath: '/repo/backlog/mockups/checkout.html',
    sourceRelativePath: 'backlog/mockups/checkout.html',
    sourceContent: '<h1>Checkout</h1>',
  }])
}

async function testBacklogRelativeRefResolvesViaSecondCandidate(): Promise<void> {
  // `mockups:` paths may be authored `backlog/`-relative (amendment 2); the
  // resolver probes the ref as written first, then under `backlog/`.
  const items = await resolveSprintEngineMockupBundleItems({
    docs: [{
      mockups: ['mockups/checkout.html'],
      sourceContent: '',
      relativePath: 'backlog/checkout.md',
    }],
    folderPath: '/repo/',
    readFile: readerOver({ '/repo/backlog/mockups/checkout.html': '<h1>Checkout</h1>' }),
  })

  assert.equal(items.length, 1)
  assert.equal(items[0].sourceRelativePath, 'backlog/mockups/checkout.html')
  assert.equal(items[0].sourcePath, '/repo/backlog/mockups/checkout.html')
}

async function testDanglingRefIsSkippedNotBundled(): Promise<void> {
  const items = await resolveSprintEngineMockupBundleItems({
    docs: [{
      mockups: ['backlog/mockups/gone.html', 'backlog/mockups/real.html'],
      sourceContent: '',
      relativePath: 'backlog/item.md',
    }],
    folderPath: '/repo',
    readFile: readerOver({ '/repo/backlog/mockups/real.html': '<p>real</p>' }),
  })

  assert.deepEqual(items.map((item) => item.sourceRelativePath), ['backlog/mockups/real.html'])
}

async function testSameFileAuthoredTwoWaysAcrossDocsDedupes(): Promise<void> {
  // Epic + child both reference one mockup, one root-relative and one
  // `backlog/`-relative: the run must carry it once.
  const items = await resolveSprintEngineMockupBundleItems({
    docs: [
      { mockups: ['backlog/mockups/shared.html'], sourceContent: '', relativePath: 'backlog/epics/e.md' },
      { mockups: ['mockups/shared.html'], sourceContent: '', relativePath: 'backlog/child.md' },
    ],
    folderPath: '/repo',
    readFile: readerOver({ '/repo/backlog/mockups/shared.html': '<p>one</p>' }),
  })

  assert.equal(items.length, 1)
}

async function testAlreadyBundledPathsAreExcluded(): Promise<void> {
  const items = await resolveSprintEngineMockupBundleItems({
    docs: [{
      mockups: ['backlog/mockups/checkout.html'],
      sourceContent: '',
      relativePath: 'backlog/item.md',
    }],
    folderPath: '/repo',
    readFile: readerOver({ '/repo/backlog/mockups/checkout.html': '<p>x</p>' }),
    excludeRelativePaths: ['backlog/mockups/checkout.html'],
  })

  assert.deepEqual(items, [])
}

async function testBodyDetectedMockupLinksAreCollected(): Promise<void> {
  // No frontmatter attachment — a `Mockup: [x](../mockups/x.html)` body link is
  // still a design source (the same rule the backlog Mockups section applies).
  const items = await resolveSprintEngineMockupBundleItems({
    docs: [{
      mockups: [],
      sourceContent: 'Mockup: [flow](../mockups/flow.html)',
      relativePath: 'backlog/epics/item.md',
    }],
    folderPath: '/repo',
    readFile: readerOver({ '/repo/backlog/mockups/flow.html': '<p>flow</p>' }),
  })

  assert.deepEqual(items.map((item) => item.sourceRelativePath), ['backlog/mockups/flow.html'])
}

function testMarkdownAdapterParsesFrontmatterMockups(): void {
  // A raw file picked outside the backlog scan still yields its `mockups:`
  // frontmatter attachments (plus body content for downstream detection).
  const doc = mockupSourceDocFromMarkdown(
    '---\nid: 42\nmockups: mockups/a.html, backlog/mockups/b.html\n---\n\n# Item\n',
    'backlog/item.md',
  )

  assert.deepEqual(doc.mockups, ['mockups/a.html', 'backlog/mockups/b.html'])
  assert.equal(doc.relativePath, 'backlog/item.md')

  const bare = mockupSourceDocFromMarkdown('# No frontmatter', 'docs/plan.md')
  assert.deepEqual(bare.mockups, [])
}

async function testEmptyFolderPathResolvesNothing(): Promise<void> {
  const items = await resolveSprintEngineMockupBundleItems({
    docs: [{ mockups: ['backlog/mockups/x.html'], sourceContent: '', relativePath: 'backlog/i.md' }],
    folderPath: '',
    readFile: readerOver({}),
  })

  assert.deepEqual(items, [])
}

async function main(): Promise<void> {
  await testAttachedMockupResolvesToBundleItem()
  await testBacklogRelativeRefResolvesViaSecondCandidate()
  await testDanglingRefIsSkippedNotBundled()
  await testSameFileAuthoredTwoWaysAcrossDocsDedupes()
  await testAlreadyBundledPathsAreExcluded()
  await testBodyDetectedMockupLinksAreCollected()
  testMarkdownAdapterParsesFrontmatterMockups()
  await testEmptyFolderPathResolvesNothing()
  console.log('sprintengineMockupSources.test.ts: ok')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
