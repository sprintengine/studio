import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ScanResult, ScannedSkill, SkillSource } from '../../../../../../../shared/skills'
import { AddSkillSourceModal } from './AddSkillSourceModal'
import { SkillDocument, SkillReader } from './SkillReader'
import { SkillSourceCanvas, type SkillSourceCanvasProps } from './SkillSourceCanvas'
import { SkillsSurface } from './SkillsSurface'

// What the rendered surface owes: two separate targets on a skill row (never a
// button inside a button), an Install that states why it is unavailable rather
// than doing nothing, and a search-first source that renders no rows until it
// is asked.

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

function skill(id: string, over: Partial<ScannedSkill> = {}): ScannedSkill {
  const name = id.split('/').slice(-1)[0]
  return {
    id,
    name,
    description: `${name} does something`,
    group: '',
    files: [{ path: 'SKILL.md', size: 900, blobSha: '', isEntry: true }],
    allowedTools: [],
    hasExecutables: false,
    ...over,
  }
}

function scanOf(skills: ScannedSkill[], over: Partial<ScanResult> = {}): ScanResult {
  return {
    skills,
    groups: [],
    groupingSignal: 'none',
    fileCount: skills.length,
    commitSha: '7a30f5200000',
    ...over,
  }
}

const SOURCE: SkillSource = {
  id: 'github:mattpocock/skills',
  kind: 'github',
  name: 'Matt Pocock',
  repo: 'mattpocock/skills',
  monogram: 'MP',
  blurb: 'Engineering and writing skills.',
  commitSha: '4f2a91c0000',
  scannedAt: '2026-07-28T09:00:00Z',
}

function canvas(over: Partial<SkillSourceCanvasProps> = {}): string {
  const scan = over.scan ?? scanOf([skill('skills/tdd'), skill('skills/triage')])
  return renderToStaticMarkup(
    <SkillSourceCanvas
      source={SOURCE}
      scan={scan}
      scanLoad={{ status: 'ready', scan }}
      installedDirNames={new Set()}
      installedError={null}
      activeGroup={null}
      onActiveGroupChange={() => {}}
      query=""
      onQueryChange={() => {}}
      selected={new Set()}
      onToggleSelect={() => {}}
      onSelectAll={() => {}}
      onClearSelection={() => {}}
      onOpenSkill={() => {}}
      availability={{ enabled: true, reason: null }}
      installing={null}
      onInstallSelected={() => {}}
      sync={{ onSync: () => {}, syncing: false, outcome: null, error: null, onOpenHistory: () => {} }}
      onBrowseMcpServers={() => {}}
      renderSkillPage={(skillId) => <div data-skill-page={skillId} />}
      {...over}
    />,
  )
}

/** A `<button>` inside another `<button>` — invalid, and one target where the
 *  design has two. */
function hasNestedButton(markup: string): boolean {
  return /<button(?:(?!<\/button>)[\s\S])*?<button/.test(markup)
}

run('a skill row carries two targets and never nests them', () => {
  const markup = canvas()
  assert.ok(markup.includes('role="checkbox"'), 'the select target is a checkbox')
  assert.ok(markup.includes('aria-label="Select tdd"'), 'the checkbox names the skill it selects')
  assert.ok(markup.includes('aria-checked="false"'))
  assert.ok(markup.includes('>Read<'), 'the row body opens the skill to be read')
  assert.equal(hasNestedButton(markup), false)
  // The row clips its children, so an outset focus ring survives as a 1px
  // sliver: both targets ring inward or the keyboard has no visible focus.
  assert.equal(markup.match(/focus-visible:ring-inset/g)?.length, 4, 'both targets on both rows')
})

run('a grouped source renders its group tree and one group of rows', () => {
  const skills = [
    skill('skills/engineering/tdd', { group: 'engineering' }),
    skill('skills/engineering/triage', { group: 'engineering' }),
    skill('skills/writing/teach', { group: 'writing' }),
  ]
  const scan = scanOf(skills, { groups: ['engineering', 'writing'], groupingSignal: 'folders' })
  const markup = canvas({ scan })
  assert.ok(markup.includes('aria-label="Groups"'), 'the groups are a list')
  assert.ok(markup.includes('>Engineering<') && markup.includes('>Writing<'))
  assert.ok(markup.includes('aria-label="Select tdd"'))
  assert.ok(!markup.includes('aria-label="Select teach"'), 'only the active group renders rows')
  assert.equal(hasNestedButton(markup), false)
})

run('a search-first source renders no rows until a category or query is chosen', () => {
  const skills = Array.from({ length: 103 }, (_, index) =>
    skill(`solutions/ecommerce/skill-${index}`, { group: 'ecommerce' }),
  )
  const scan = scanOf(skills, { groups: ['ecommerce'], groupingSignal: 'folders' })
  const markup = canvas({ scan })
  assert.ok(markup.includes('Pick a category, or search.'))
  assert.ok(!markup.includes('role="checkbox"'), 'no rows are rendered yet')
  assert.ok(markup.includes('placeholder="Search 103 skills"'))
})

run('a solo source renders the skill page, not a list of one', () => {
  const markup = canvas({ scan: scanOf([skill('impeccable')]) })
  assert.ok(markup.includes('data-skill-page="impeccable"'))
  assert.ok(!markup.includes('role="checkbox"'))
})

run('the connector skills deflect to MCP servers', () => {
  const skills = Array.from({ length: 194 }, (_, index) => skill(`skills/connector-${index}`))
  const markup = canvas({
    source: { ...SOURCE, id: 'connectors', kind: 'connectors', name: 'Connectors', repo: '' },
    scan: scanOf(skills),
  })
  assert.ok(markup.includes('These 194 skills are paired with their MCP connectors.'))
  assert.ok(markup.includes('Browse MCP servers'))
  assert.ok(!markup.includes('role="checkbox"'), 'none of the 194 are listed here')
})

run('with no workspace the Install affordances are disabled and say why', () => {
  const markup = canvas({
    availability: {
      enabled: false,
      reason: 'Open a workspace to install skills — a skill installs into a workspace, not into the app.',
    },
  })
  assert.ok(markup.includes('Open a workspace to install skills'), 'the reason is visible, not a tooltip')
  const install = markup.slice(markup.lastIndexOf('<button', markup.indexOf('Install')))
  assert.ok(install.includes('disabled'), 'Install is disabled rather than silently doing nothing')
})

run('a failed installed-skills read is disclosed, never rendered as "not installed"', () => {
  const markup = canvas({ installedError: 'Workspace root does not exist.' })
  assert.ok(markup.includes('Installed skills in this workspace could not be read'))
})

run('an installed skill says so on its row', () => {
  const markup = canvas({ installedDirNames: new Set(['tdd']) })
  assert.ok(markup.includes('>Installed<'))
})

run('Add a source is a centred modal with an accessible name', () => {
  const markup = renderToStaticMarkup(
    <AddSkillSourceModal open onClose={() => {}} onAdded={() => {}} onRemoved={() => {}} />,
  )
  assert.ok(markup.includes('role="dialog"') && markup.includes('aria-modal="true"'))
  assert.ok(markup.includes('id="add-skill-source-title"'))
  assert.ok(markup.includes('items-center justify-center'), 'the modal is centred over a scrim')
  assert.ok(markup.includes('Scan and add'))
  assert.equal(hasNestedButton(markup), false)
})

run('the surface opens on a nested source rail that keeps Add and Discover', () => {
  const scan = scanOf([skill('skills/tdd'), skill('skills/triage')])
  const markup = renderToStaticMarkup(
    <SkillsSurface
      workspaceRoot="/proj"
      onBrowseMcpServers={() => {}}
      sources={{
        sources: [
          { ...SOURCE, id: 'builtin', kind: 'builtin', name: 'Multicode', repo: '', monogram: 'MC' },
          SOURCE,
        ],
        sourcesLoad: { status: 'ready' },
        scans: { builtin: { status: 'loading' }, [SOURCE.id]: { status: 'ready', scan } },
        installedDirNames: new Set(),
        installedRead: { status: 'ready' },
        refreshSources: () => {},
        refreshScan: () => {},
        refreshInstalled: () => {},
        applySync: () => {},
      }}
    />,
  )
  assert.ok(markup.includes('aria-label="Skill sources"'), 'the sources rail is a nested nav')
  assert.ok(markup.includes('>Add a source<'), 'Add a source belongs to Skills, not the global rail')
  assert.ok(markup.includes('>Discover<'), 'Discover belongs to Skills, at the rail foot')
  assert.ok(markup.includes('>Multicode<') && markup.includes('>mattpocock/skills<'))
  // The rail states each source's own read state; a pending scan is not a zero.
  assert.ok(markup.includes('>Loading…<') && markup.includes('>2 skills<'))
})

// ── The reader ───────────────────────────────────────────────────────────────

const READER_SKILL = skill('skills/engineering/prototype', {
  files: [
    { path: 'SKILL.md', size: 2400, blobSha: '', isEntry: true },
    { path: 'LOGIC.md', size: 1800, blobSha: '', isEntry: false },
    { path: 'scripts/run.sh', size: 320, blobSha: '', isEntry: false },
  ],
})

function document(content: string, path = 'SKILL.md'): string {
  const file = READER_SKILL.files.find((candidate) => candidate.path === path) ?? READER_SKILL.files[0]
  return renderToStaticMarkup(
    <SkillDocument
      file={file}
      files={READER_SKILL.files}
      read={{ status: 'ready', content }}
      onOpenFile={() => {}}
      onRetry={() => {}}
    />,
  )
}

run('the reader lists every file, opens on SKILL.md, and marks it as the entry', () => {
  const markup = renderToStaticMarkup(<SkillReader source={SOURCE} skill={READER_SKILL} />)
  assert.ok(markup.includes('aria-label="Files in this skill"'))
  assert.ok(markup.includes('>SKILL.md<') && markup.includes('>LOGIC.md<'))
  assert.ok(markup.includes('>scripts/run.sh<'), 'the files it would run are listed too')
  assert.ok(markup.includes('>Entry<'), 'SKILL.md is marked as the entry')
  // The entry row is the current one, and the reader is already reading it.
  const entryRow = markup.slice(markup.indexOf('<button'), markup.indexOf('>SKILL.md<'))
  assert.ok(entryRow.includes('aria-current="true"'))
  assert.ok(markup.includes('Reading SKILL.md…'))
  assert.equal(hasNestedButton(markup), false)
})

run('a skill file cannot inject markup', () => {
  const markup = document(
    '# Heading\n\n<script>steal()</script>\n\n<img src=x onerror="steal()">\n\n'
      + '[run it](javascript:steal()) and [ok](https://example.com)\n',
  )
  assert.ok(!markup.includes('<script'), 'a script tag is text, never a tag')
  assert.ok(markup.includes('&lt;script&gt;'))
  assert.ok(!markup.includes('<img'), 'and neither is an img that carries a handler')
  assert.ok(markup.includes('&lt;img'), 'it is shown as the text the file actually contains')
  assert.ok(!markup.includes('javascript:'), 'a javascript: href never reaches the DOM')
  assert.ok(markup.includes('href="https://example.com"'), 'a real link still opens')
  assert.ok(markup.includes('<h1'), 'and the document still renders')
})

run('markdown renders as a document, at the surface’s own scale', () => {
  const markup = document(
    '---\nname: prototype\n---\n\n# Prototype\n\n## Why\n\n- one\n- two\n\n1. first\n\n'
      + '> a quote\n\n`inline/path.ts` and\n\n```ts\nconst x = 1\n```\n',
  )
  assert.ok(!markup.includes('name: prototype'), 'frontmatter is stated above the document, not in it')
  assert.ok(markup.includes('<h1') && markup.includes('<h2'))
  assert.ok(markup.includes('<ul') && markup.includes('<ol') && markup.includes('<blockquote'))
  assert.ok(markup.includes('<pre') && markup.includes('const x = 1'))
  // Inline code sits inside running text: it takes that text's size and wraps.
  const code = markup.slice(markup.indexOf('<code'), markup.indexOf('inline/path.ts'))
  assert.ok(code.includes('text-[0.92em]') && code.includes('break-words'))
  assert.ok(!markup.includes('text-3xl'), 'the document scale would dwarf the page it sits in')
})

run('a relative link opens its file; one the scan never carried is dead, not broken', () => {
  const markup = document('See [the logic](LOGIC.md) and [the shape](SHAPE.md).\n')
  const live = markup.slice(markup.indexOf('<button'), markup.indexOf('the logic'))
  assert.ok(live.includes('type="button"'), 'a sibling file opens in the reader')
  const dead = markup.slice(markup.lastIndexOf('<span', markup.indexOf('the shape')), markup.indexOf('the shape'))
  assert.ok(dead.includes('decoration-dotted'), 'a missing companion is muted and dotted')
  assert.ok(dead.includes('text-[color:var(--text-muted)]'), 'never the danger colour')
  assert.ok(dead.includes("SHAPE.md is not one of this skill&#x27;s files."), 'and it says why on hover')
})

run('a non-markdown file is shown as its own text, not rendered as markdown', () => {
  const markup = document('#!/bin/sh\n# not a heading\nexit 0\n', 'scripts/run.sh')
  assert.ok(markup.includes('<pre'))
  assert.ok(!markup.includes('<h1'), 'a shell comment is not a heading')
  assert.ok(markup.includes('# not a heading'))
})

run('a file that could not be read says so and offers the read again', () => {
  const markup = renderToStaticMarkup(
    <SkillDocument
      file={READER_SKILL.files[0]}
      files={READER_SKILL.files}
      read={{ status: 'error', message: 'GitHub rate limit reached.' }}
      onOpenFile={() => {}}
      onRetry={() => {}}
    />,
  )
  assert.ok(markup.includes('SKILL.md could not be read.'))
  assert.ok(markup.includes('GitHub rate limit reached.'), 'the real reason, not a generic failure')
  assert.ok(markup.includes('Try again'))
})

run('a source offers Sync and the history that says what changed', () => {
  const markup = canvas()
  assert.ok(markup.includes('>Sync<'))
  assert.ok(markup.includes('>Commit history<'), 'what changed is answered by the repository, not by us')
  assert.ok(!/added|removed|changelog/i.test(markup), 'no diff or changelog view exists here')
  assert.equal(hasNestedButton(markup), false)
})

run('a sync in flight says so on the control that started it', () => {
  const markup = canvas({
    sync: { onSync: () => {}, syncing: true, outcome: null, error: null, onOpenHistory: () => {} },
  })
  const sync = markup.slice(markup.lastIndexOf('<button', markup.indexOf('Syncing')))
  assert.ok(sync.includes('disabled'), 'a second sync cannot be started over the first')
})

run('the sync outcome is one line of plain text in the header', () => {
  const markup = canvas({
    sync: {
      onSync: () => {},
      syncing: false,
      outcome: 'Synced · 3 new skills',
      error: null,
      onOpenHistory: () => {},
    },
  })
  assert.ok(markup.includes('Synced · 3 new skills'))
  assert.ok(!markup.includes('role="dialog"'), 'the outcome is a line, never a modal')
})

run('a failed sync states the failure instead of looking freshly synced', () => {
  const markup = canvas({
    sync: {
      onSync: () => {},
      syncing: false,
      outcome: null,
      error: 'GitHub rate-limited this request.',
      onOpenHistory: () => {},
    },
  })
  assert.ok(markup.includes('mattpocock/skills could not be synced.'))
  assert.ok(markup.includes('GitHub rate-limited this request.'), 'the real reason, not a generic failure')
  assert.ok(!markup.includes('Synced ·'), 'nothing claims a sync that did not happen')
})

run('a source with nothing to re-read offers no Sync', () => {
  const markup = canvas({
    source: { ...SOURCE, id: 'builtin', kind: 'builtin', name: 'Multicode', repo: '' },
    sync: { onSync: null, syncing: false, outcome: null, error: null, onOpenHistory: null },
  })
  assert.ok(!markup.includes('>Sync<'))
  assert.ok(!markup.includes('>Commit history<'))
})

run('the closed modal renders nothing', () => {
  const markup = renderToStaticMarkup(
    <AddSkillSourceModal open={false} onClose={() => {}} onAdded={() => {}} onRemoved={() => {}} />,
  )
  assert.equal(markup, '')
})

console.log('skills surface render tests passed')
