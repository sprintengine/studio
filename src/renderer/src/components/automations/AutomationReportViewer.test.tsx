import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { renderToStaticMarkup } from 'react-dom/server'

import {
  ReportPathPicker,
  ReportViewBody,
  isHtmlReport,
  loadReportContent,
  type ReportFilesystem,
  type ReportViewState,
} from './AutomationReportViewer'

let failures = 0
const pending: Array<Promise<void>> = []
function run(name: string, fn: () => void | Promise<void>): void {
  pending.push(
    Promise.resolve()
      .then(fn)
      .then(
        () => console.log(`ok - ${name}`),
        (error) => {
          failures += 1
          console.error(`not ok - ${name}`)
          console.error(error)
        },
      ),
  )
}

const WORKSPACE = '/repo'

// A recording stub for the two filesystem calls the viewer makes. Each call is
// logged so a test can assert both the path resolution and that the wrong
// branch was never taken (e.g. an html report must not read inline).
function stubFs(overrides: Partial<ReportFilesystem> = {}): {
  fs: ReportFilesystem
  reads: string[]
  opens: string[]
} {
  const reads: string[] = []
  const opens: string[] = []
  const fs: ReportFilesystem = {
    readfile: async (path) => {
      reads.push(path)
      throw new Error('not stubbed')
    },
    openHtmlFileInBrowser: async (path) => {
      opens.push(path)
    },
    ...overrides,
  }
  return { fs, reads, opens }
}

// ---- loadReportContent: the read/open branches (stubbed filesystem) ---------

run('a .md report reads <workspaceRoot>/<path> and renders as markdown', async () => {
  const { fs, reads, opens } = stubFs({
    readfile: async (path) => {
      reads.push(path)
      return '# Findings\n\nAll clear.'
    },
  })
  const state = await loadReportContent(fs, WORKSPACE, 'reports/run-1.md')
  assert.deepEqual(reads, ['/repo/reports/run-1.md'], 'reads the path resolved under the workspace root')
  assert.equal(opens.length, 0, 'a markdown report never opens the browser')
  assert.equal(state.kind, 'markdown')
  assert.equal(state.kind === 'markdown' && state.markdown, '# Findings\n\nAll clear.')
})

run('a readfile rejection (missing/un-merged file) yields the not-found state', async () => {
  const { fs } = stubFs({
    readfile: async () => {
      throw new Error('ENOENT')
    },
  })
  const state = await loadReportContent(fs, WORKSPACE, 'reports/missing.md')
  assert.equal(state.kind, 'not-found')
})

run('an .html report opens in the browser and is never read inline', async () => {
  const { fs, reads, opens } = stubFs()
  const state = await loadReportContent(fs, WORKSPACE, 'reports/run-1.html')
  assert.deepEqual(opens, ['/repo/reports/run-1.html'], 'opens the resolved path in the browser')
  assert.equal(reads.length, 0, 'an html report does not call readfile')
  assert.equal(state.kind, 'html')
})

run('an html open failure also falls back to not-found', async () => {
  const { fs } = stubFs({
    openHtmlFileInBrowser: async () => {
      throw new Error('open failed')
    },
  })
  const state = await loadReportContent(fs, WORKSPACE, 'reports/run-1.html')
  assert.equal(state.kind, 'not-found')
})

run('isHtmlReport distinguishes .html from .md (case-insensitive)', () => {
  assert.equal(isHtmlReport('reports/a.html'), true)
  assert.equal(isHtmlReport('reports/a.HTML'), true)
  assert.equal(isHtmlReport('reports/a.md'), false)
})

// ---- ReportViewBody: each terminal state renders correctly ------------------

function body(state: ReportViewState, pullRequestUrl?: string): string {
  return renderToStaticMarkup(
    <ReportViewBody state={state} pullRequestUrl={pullRequestUrl} onReopenHtml={() => {}} />,
  )
}

run('the markdown state renders the report content via renderMarkdown', () => {
  const markup = body({ kind: 'markdown', markdown: '# Security findings\n\nNo issues.' })
  assert.match(markup, /markdown-rendered/, 'content goes through the shared markdown renderer')
  assert.match(markup, /Security findings/, 'the heading text renders')
  assert.match(markup, /No issues\./, 'the body text renders')
})

run('the not-found state shows the merge message and the Pull request link when present', () => {
  const markup = body({ kind: 'not-found' }, 'https://github.com/o/r/pull/7')
  assert.match(markup, /hasn’t been merged yet/, 'the not-found copy is shown')
  assert.match(markup, /href="https:\/\/github\.com\/o\/r\/pull\/7"/, 'the PR link points at the run PR')
  assert.match(markup, /Pull request/, 'the link is labelled')
})

run('the not-found state without a PR renders no dead link', () => {
  const markup = body({ kind: 'not-found' })
  assert.match(markup, /hasn’t been merged yet/, 'the message still shows')
  assert.ok(!markup.includes('<a '), 'no anchor without a pullRequestUrl')
})

run('the html state reports the browser hand-off and offers Open again, not inline content', () => {
  const markup = body({ kind: 'html' })
  assert.match(markup, /opened in your browser/, 'the html hand-off is explained')
  assert.match(markup, /Open again/, 'a re-open affordance is offered')
  assert.ok(!markup.includes('markdown-rendered'), 'html is never inline-rendered as markdown')
})

run('the loading state shows a labelled spinner', () => {
  const markup = body({ kind: 'loading' })
  assert.match(markup, /Loading report/, 'the loading state is labelled')
})

// ---- ReportPathPicker: multi-report switching -------------------------------

run('the picker lists every report and marks the active one', () => {
  const markup = renderToStaticMarkup(
    <ReportPathPicker
      paths={['reports/a.md', 'reports/b.html']}
      activePath="reports/a.md"
      onSelect={() => {}}
    />,
  )
  assert.match(markup, />a\.md</, 'first report listed by basename')
  assert.match(markup, />b\.html</, 'second report listed by basename')
  // Exactly one button is pressed — the single accent lands on the active report.
  const pressed = markup.match(/aria-pressed="true"/g) ?? []
  assert.equal(pressed.length, 1, 'exactly one active report button')
})

run('clicking a picker tab selects that path', () => {
  let picked: string | null = null
  // Drive the click handler directly off the element tree the picker builds.
  const tree = ReportPathPicker({
    paths: ['reports/a.md', 'reports/b.html'],
    activePath: 'reports/a.md',
    onSelect: (path) => {
      picked = path
    },
  })
  const tabs = (tree.props.children as Array<{ props: { onClick: () => void } }>).filter(Boolean)
  const second = tabs[1]
  second.props.onClick()
  assert.equal(picked, 'reports/b.html', 'selecting the second tab reports its path upward')
})

// ---- Component wiring the static render cannot reach ------------------------
// The overlay's effect + dismissal are store/lifecycle-bound (the Drawer renders
// null until its enter frames run), so assert them against the source the same
// way the Backlog row tests assert panel wiring.
const viewerSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/automations/AutomationReportViewer.tsx'),
  'utf8',
)

run('the active report loads through loadReportContent in an effect keyed on the selection', () => {
  assert.match(
    viewerSource,
    /useEffect\(\(\) => \{[\s\S]*loadReportContent\(window\.api, workspaceRoot, activePath\)[\s\S]*\}, \[activePath, workspaceRoot\]\)/,
    'the load runs in an effect re-keyed on activePath, so picking a report loads it',
  )
})

run('the picker selection is wired to setActivePath', () => {
  assert.match(
    viewerSource,
    /<ReportPathPicker[^>]*onSelect=\{setActivePath\}/,
    'choosing a report updates the active selection that the effect reloads on',
  )
})

run('the overlay delegates Esc / close / focus to the Drawer primitive via onClose', () => {
  assert.match(
    viewerSource,
    /<Drawer open onClose=\{onClose\}/,
    'rendered inside Drawer, which owns Escape, backdrop close, focus capture and restoration',
  )
})

void Promise.all(pending).then(() => {
  if (failures > 0) {
    console.error(`AutomationReportViewer.test.tsx: ${failures} failing`)
    process.exit(1)
  }
  console.log('AutomationReportViewer.test.tsx: ok')
})
