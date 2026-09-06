import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import type {
  ScanResult,
  ScannedSkill,
  SkillDiscoveryCondition,
  SkillDiscoveryResult,
  SkillRepoHit,
  SkillSearchHit,
  SkillSource,
} from '../../../../../../../shared/skills'
import { FOCUS_RING_CLASS } from '../../../../ui/tokens'
import { SourceTabActions } from '../catalogue/SourceTabActions'
import { AddSkillSourceModal } from './AddSkillSourceModal'
import { SkillPage } from './SkillPage'
import { SkillDocument, SkillReader } from './SkillReader'
import {
  DiscoverRepoList,
  DiscoverSearchResults,
  SkillsDiscover,
  type DiscoverLoad,
} from './SkillsDiscover'

/** A clean answer: results, and nothing GitHub could not do. */
function hitResult<T>(results: T[]): SkillDiscoveryResult<T> {
  return { results, rateLimit: null, degraded: null }
}

// The Skills surface's PIECES: the Add-a-source modal, the skill page, the
// reader, and Discover. The source page itself is no longer one of them — the
// source-tabs ruling (2026-09-05) replaced `SkillSourceCanvas`'s four layouts
// and its nested Sources rail with the shared catalogue frame, which is
// exercised in catalogue/extensionsCatalogue.test.tsx against a real DOM
// (it reads the store, which a markup-only render cannot give it).

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

run('Add a source is a centred modal with an accessible name, and carries Discover', () => {
  const markup = renderToStaticMarkup(
    <AddSkillSourceModal open onClose={() => {}} onAdded={() => {}} onRemoved={() => {}} />,
  )
  assert.ok(markup.includes('role="dialog"') && markup.includes('aria-modal="true"'))
  assert.ok(markup.includes('id="add-skill-source-title"'))
  assert.ok(markup.includes('items-center justify-center'), 'the modal is centred over a scrim')
  assert.ok(markup.includes('>Add<'))
  // Discover moved in here when the source-tabs ruling (2026-09-05) retired the
  // Sources rail that used to carry it in its foot: it is the same question the
  // modal asks, for someone with no repository in mind.
  assert.ok(markup.includes('Search GitHub'), 'and offers the search for someone with no repository in mind')
  assert.equal(hasNestedButton(markup), false)
})

/** A `<button>` inside another `<button>` — invalid, and one target where the
 *  design has two. */
function hasNestedButton(markup: string): boolean {
  return /<button(?:(?!<\/button>)[\s\S])*?<button/.test(markup)
}

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
  // It is the one control in the reader the surface does not render itself, and
  // it must not be the one control wearing a different focus ring.
  assert.ok(live.includes(FOCUS_RING_CLASS), 'and it carries the surface’s own focus ring')
  const dead = markup.slice(markup.lastIndexOf('<span', markup.indexOf('the shape')), markup.indexOf('the shape'))
  assert.ok(dead.includes('decoration-dotted'), 'a missing companion is muted and dotted')
  assert.ok(dead.includes('text-[color:var(--text-muted)]'), 'never the danger colour')
  assert.ok(dead.includes("SHAPE.md is not one of this skill&#x27;s files."), 'and it says why on hover')
  // A dead link is not focusable, so the reason is spoken too, not hover-only.
  assert.ok(
    markup.includes('<span class="sr-only"> — SHAPE.md is not one of this skill&#x27;s files.</span>'),
    'the reason reaches a screen reader as well',
  )
})

run('a skill page opened from a listing names its source once, on the way back', () => {
  const one = skill('skills/tdd')
  const page = (onBack?: () => void): string =>
    renderToStaticMarkup(
      <SkillPage
        source={SOURCE}
        skill={one}
        installed={false}
        installing={false}
        availability={{ enabled: true, reason: null }}
        onInstall={() => {}}
        onBack={onBack}
      />,
    )
  const occurrences = (markup: string): number =>
    markup.split(SOURCE.repo).length - 1
  // The crumb carries it; the line under the title would only say it again.
  assert.equal(occurrences(page(() => {})), 1, 'the crumb states the source, and nothing restates it')
  assert.ok(page(() => {}).includes('1 file'), 'the file count stays on that line')
  // A source that IS one skill has no crumb, so the line is where it is stated.
  assert.equal(occurrences(page(undefined)), 1, 'with no crumb the line names the source')
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

// ── The source's own actions ─────────────────────────────────────────────────
// Sync, Open on GitHub and Remove sat on the Sources rail's source page. With
// the rail gone (source-tabs ruling, 2026-09-05) they are the head line under
// the tab row: Sync stays outside the menu because it is the one a person does
// repeatedly and it reports its own progress; the other two are behind an
// overflow, because a tab is navigation and a Remove inside a navigation is a
// click meant for "look at this" that deletes it.

function actions(over: Partial<SkillSource> = {}): string {
  return renderToStaticMarkup(
    <SourceTabActions
      source={{ ...SOURCE, ...over }}
      workspaceRoot="/proj"
      onSynced={() => {}}
      onSyncFailed={() => {}}
      onRemoved={() => {}}
    />,
  )
}

run('a repository source offers Sync, and the rest behind one overflow', () => {
  const markup = actions()
  assert.ok(markup.includes('>Sync<'))
  assert.ok(markup.includes('aria-label="More actions for mattpocock/skills"'))
  assert.ok(!/added|removed|changelog/i.test(markup), 'no diff or changelog view exists here')
})

run('a source the check has seen move on says so on the control that fixes it', () => {
  const markup = actions({ headSha: 'ffffffff' })
  assert.ok(
    markup.includes('Sync — update available'),
    'the mark rides the control that lands the update, not a badge beside it',
  )
})

run('a bundled source has nothing to re-read and nothing to remove', () => {
  const markup = actions({ id: 'builtin', kind: 'builtin', name: 'Multicode', repo: '' })
  assert.equal(markup, '', 'so it renders no actions at all rather than dead ones')
})

// ── Discover ─────────────────────────────────────────────────────────────────

const REPO_HITS: SkillRepoHit[] = [
  {
    repo: 'browser-act/skills',
    description: 'Web automation skills.',
    stars: 4900,
    htmlUrl: 'https://github.com/browser-act/skills',
    curated: true,
  },
  {
    repo: 'pbakaus/impeccable',
    description: '',
    stars: 52341,
    htmlUrl: 'https://github.com/pbakaus/impeccable',
    curated: false,
  },
]

const SEARCH_HITS: SkillSearchHit[] = [
  {
    repo: 'anthropics/skills',
    path: 'document-skills/pdf/SKILL.md',
    skillId: 'document-skills/pdf',
    name: 'pdf',
    description: 'Extract text from PDFs.',
    htmlUrl: 'https://github.com/anthropics/skills/blob/HEAD/document-skills/pdf/SKILL.md',
  },
]

function condition(
  reason: SkillDiscoveryCondition['reason'],
  message: string,
): SkillDiscoveryCondition {
  return { reason, message, retryAfterSeconds: 0 }
}

function repoList(
  load: DiscoverLoad<SkillRepoHit>,
  addedRepos: ReadonlySet<string> = new Set(),
): string {
  return renderToStaticMarkup(
    <DiscoverRepoList
      load={load}
      addedRepos={addedRepos}
      onScanRepo={() => {}}
      onRetry={() => {}}
      onConfigureToken={() => {}}
    />,
  )
}

function searchResults(load: DiscoverLoad<SkillSearchHit>): string {
  return renderToStaticMarkup(
    <DiscoverSearchResults
      load={load}
      intent={{ kind: 'pending' }}
      addedRepos={new Set()}
      onScanRepo={() => {}}
      onRetry={() => {}}
      onConfigureToken={() => {}}
    />,
  )
}

run('Discover offers a stars sort and a search, and never calls either one trending', () => {
  const markup = renderToStaticMarkup(
    <SkillsDiscover addedRepos={new Set()} onScanRepo={() => {}} onConfigureToken={() => {}} />,
  )
  assert.ok(markup.includes('>Most starred<') && markup.includes('>Search<'))
  assert.equal(/trending/i.test(markup), false, 'GitHub has no trending API to name one after')
  assert.ok(markup.includes('role="radiogroup"'), 'the two tabs are one mutually exclusive control')
  assert.equal(hasNestedButton(markup), false)
})

run('a result row states what GitHub returned, and never a skill count', () => {
  const markup = repoList({ status: 'ready', query: '', result: hitResult(REPO_HITS) })
  assert.ok(markup.includes('>browser-act/skills<') && markup.includes('Web automation skills.'))
  assert.ok(markup.includes('>4.9k<') && markup.includes('>52k<'), 'stars, as GitHub reported them')
  assert.equal(/\d+\s+skills?</.test(markup), false, 'a count needs a scan; stars do not predict one')
  assert.ok(markup.includes('>Scan<'), 'and the row hands the repository to the scan')
  // A column of identical "Scan" buttons is unnavigable by ear; each names its
  // own repository, as the star count names its unit.
  assert.ok(markup.includes('aria-label="Scan browser-act/skills"'))
  assert.ok(markup.includes('<span class="sr-only"> stars</span>'))
  assert.equal(hasNestedButton(markup), false)
})

run('a repository with no star count shows none, never a zero', () => {
  const markup = repoList({
    status: 'ready',
    query: '',
    result: hitResult([{ ...REPO_HITS[0], stars: null }]),
  })
  assert.ok(markup.includes('>Manifest<'), 'why it leads the list is stated')
  assert.equal(markup.includes('>0<'), false)
})

run('a repository already in the source list reads as Added, with nothing to press', () => {
  const markup = repoList(
    { status: 'ready', query: '', result: hitResult([REPO_HITS[0]]) },
    new Set(['browser-act/skills']),
  )
  assert.ok(markup.includes('>Added<'))
  assert.equal(markup.includes('>Scan<'), false)
})

run('rate-limit exhaustion is stated; the list is never silently empty', () => {
  const markup = repoList({
    status: 'ready',
    query: '',
    result: {
      results: [],
      rateLimit: { limit: 10, remaining: 0, resetAt: '' },
      degraded: condition('rate_limited', "GitHub's search limit is used up. It resets in about 1 min."),
    },
  })
  assert.ok(markup.includes("GitHub&#x27;s search limit is used up. It resets in about 1 min."))
  assert.ok(markup.includes('No searches left in this minute.'))
  assert.equal(markup.includes('no repositories tagged'), false, 'an exhausted budget is not "no match"')
})

run('with no token Most starred still lists, and says what the list is missing', () => {
  const markup = repoList({
    status: 'ready',
    query: '',
    result: {
      results: [REPO_HITS[1]],
      rateLimit: null,
      degraded: condition('needs_token', 'Searching inside skill files needs a GitHub access token.'),
    },
  })
  assert.ok(markup.includes('>pbakaus/impeccable<'), 'the stars half answered, so it is shown')
  assert.ok(markup.includes('this list is stars only'), 'and what is missing from it is stated')
  assert.equal(markup.includes('role="alert"'), false, 'a working list is not a failure')
})

run('with no token the Search tab says so and offers the route to set one', () => {
  const markup = searchResults({
    status: 'ready',
    query: 'extract text from PDFs',
    result: {
      results: [],
      rateLimit: null,
      degraded: condition(
        'needs_token',
        'Searching inside skill files needs a GitHub access token. Add one in Settings under GitHub.',
      ),
    },
  })
  assert.ok(markup.includes('needs a GitHub access token'))
  assert.ok(markup.includes('>Add a GitHub token<'), 'the notice carries the way to fix it')
  assert.ok(markup.includes('The most starred list works without one.'))
  assert.equal(markup.includes('Results for'), false, 'no result list is claimed for a search that never ran')
})

run('a search hit is a skill, labelled with the query it belongs to', () => {
  const markup = searchResults({
    status: 'ready',
    query: 'extract text from PDFs',
    result: hitResult(SEARCH_HITS),
  })
  assert.ok(markup.includes('Results for “extract text from PDFs”'))
  assert.ok(markup.includes('>pdf<') && markup.includes('Extract text from PDFs.'))
  assert.ok(markup.includes('>anthropics/skills<'), 'the repository it came from is on the row')
  assert.equal(/\d+\s+skills?</.test(markup), false)
  assert.ok(markup.includes('>Scan<'))
  assert.equal(hasNestedButton(markup), false)
})

run('a search that matched nothing says which query, in its own words', () => {
  const markup = searchResults({ status: 'ready', query: 'yodelling', result: hitResult([]) })
  assert.ok(markup.includes('No SKILL.md on GitHub matches “yodelling”.'))
})

run('Scan opens the Add-a-source modal on that repository', () => {
  const markup = renderToStaticMarkup(
    <AddSkillSourceModal
      open
      initialRepo="browser-act/skills"
      onClose={() => {}}
      onAdded={() => {}}
      onRemoved={() => {}}
    />,
  )
  assert.ok(markup.includes('value="browser-act/skills"'), 'the candidate lands in the pasted-URL field')
  assert.ok(markup.includes('>Add<'), 'and takes the same path from there')
})

run('the closed modal renders nothing', () => {
  const markup = renderToStaticMarkup(
    <AddSkillSourceModal open={false} onClose={() => {}} onAdded={() => {}} onRemoved={() => {}} />,
  )
  assert.equal(markup, '')
})

console.log('skills surface render tests passed')
