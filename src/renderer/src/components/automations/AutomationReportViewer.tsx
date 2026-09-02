import React, { useCallback, useEffect, useRef, useState } from 'react'

import {
  FOCUS_RING_CLASS,
  GhostButton,
  InlineNotice,
  PrimaryButton,
  Select,
  SidePaneHeader,
  Spinner,
  TruncatedText,
} from '../ui'
import { renderMarkdown } from '../../utils/markdown'
import { basename, joinFilePath } from '../../utils/paths'

// In-app viewer for a single automation run's report. The run owns the report
// link (T4 threads `onViewReport(run)`); this side pane reads and renders it.
//
// Renders as the body of a right-hand SidePane (the caller owns the SidePane
// chrome), matching how Sprint Engine, Switchboard, and the Backlog open a
// selected item beside the list rather than over it — not a full-window overlay.
//
// Reports are markdown or html files committed under `reports/`. The paths are
// already validated upstream (contained under `reports/`, project-relative) —
// this component only resolves them under `workspaceRoot` for the read:
//   - `.md`   → read + render inline via renderMarkdown() (XSS-safe: ReactMarkdown,
//     no rehype-raw, urlTransform whitelist)
//   - `.html` → the file is agent-authored (an LLM automation wrote it, so it is
//     prompt-injectable) and opening it hands raw HTML/JS to the external
//     browser at a file:// origin, bypassing the markdown sanitizer. So we do
//     NOT open it on the View-report click: we probe that the file exists, then
//     render a confirm gate ('this can run code') and only open on explicit
//     confirm. Markdown's sanitization never covers this path, which is why it
//     is gated rather than inlined.
//   - a read failure (most commonly: the report's PR hasn't merged, so the file
//     isn't on this checkout yet) → an explicit not-found state that surfaces
//     the run's Pull request link as the way forward. Both .md and .html resolve
//     not-found through the same readfile probe, so an un-merged .html lands on
//     not-found rather than a false 'opened in your browser'.

export type ReportFilesystem = {
  readfile: (path: string) => Promise<string>
  openHtmlFileInBrowser: (targetPath: string) => Promise<void>
}

export type ReportViewState =
  | { kind: 'loading' }
  | { kind: 'markdown'; markdown: string }
  // The html file exists on disk and is awaiting explicit confirmation before
  // it is handed to the external browser (it can run code).
  | { kind: 'html-confirm' }
  // The user confirmed and the report was opened in the external browser.
  | { kind: 'html-opened' }
  | { kind: 'not-found' }

/** An html report is gated behind a confirm; everything else renders inline. */
export function isHtmlReport(reportPath: string): boolean {
  return /\.html$/i.test(reportPath)
}

// Pure data layer: resolve one report path to a non-terminal view state. Kept
// separate from React so the read branches are asserted directly against a
// stubbed filesystem rather than through rendered effects. Crucially, loading a
// report has NO side effect: an html report is never opened here — that only
// happens on an explicit confirm in the component.
export async function loadReportContent(
  fs: ReportFilesystem,
  workspaceRoot: string,
  reportPath: string,
): Promise<ReportViewState> {
  const target = joinFilePath(workspaceRoot, reportPath)
  if (isHtmlReport(reportPath)) {
    // Probe existence/readability the same way the .md branch does: an un-merged
    // (missing) file rejects and falls through to not-found, instead of relying
    // on the browser-open call to surface the miss. The content is discarded —
    // agent-authored html is never inlined.
    try {
      await fs.readfile(target)
    } catch {
      return { kind: 'not-found' }
    }
    return { kind: 'html-confirm' }
  }
  try {
    const markdown = await fs.readfile(target)
    return { kind: 'markdown', markdown }
  } catch {
    return { kind: 'not-found' }
  }
}

export function AutomationReportViewer({
  workspaceRoot,
  reportPaths,
  pullRequestUrl,
  onClose,
}: {
  workspaceRoot: string
  /** Already-validated, project-relative report paths under `reports/`. */
  reportPaths: string[]
  /** The run's PR, surfaced as the recovery action when a report isn't merged yet. */
  pullRequestUrl?: string
  onClose: () => void
}): JSX.Element {
  const [activePath, setActivePath] = useState<string | null>(reportPaths[0] ?? null)
  const [state, setState] = useState<ReportViewState>(
    reportPaths.length > 0 ? { kind: 'loading' } : { kind: 'not-found' },
  )

  // Load the active report; re-runs when the user picks a different one. The
  // load is side-effect free for every kind, including html — an html pick
  // resolves to the confirm gate, it does not open the browser. Opening only
  // happens on the explicit confirm below.
  useEffect(() => {
    if (!activePath) return undefined
    let cancelled = false
    setState({ kind: 'loading' })
    void loadReportContent(window.api, workspaceRoot, activePath).then((next) => {
      if (!cancelled) setState(next)
    })
    return () => {
      cancelled = true
    }
  }, [activePath, workspaceRoot])

  // The one place an agent-authored html report is handed to the external
  // browser: only on an explicit user confirmation (or re-open). An open failure (e.g.
  // the file vanished after the existence probe) falls back to not-found.
  const openHtml = useCallback(() => {
    if (!activePath) return
    void window.api.openHtmlFileInBrowser(joinFilePath(workspaceRoot, activePath)).then(
      () => setState({ kind: 'html-opened' }),
      () => setState({ kind: 'not-found' }),
    )
  }, [activePath, workspaceRoot])

  const title = reportPaths.length > 1 ? 'Run reports' : activePath ? basename(activePath) : 'Run report'

  // Focus the pane on open so Escape closes it (parity with the prior Drawer),
  // scoped to this surface — the keydown lives on the pane, so it never reaches
  // the definition list's own Escape handler behind it.
  const paneRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    paneRef.current?.focus()
  }, [])

  return (
    <div
      ref={paneRef}
      tabIndex={-1}
      role="region"
      aria-label="Automation run report"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
      className="flex h-full min-h-0 flex-col outline-none"
    >
      <SidePaneHeader title={title} onClose={onClose} closeLabel="Close report" />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="flex flex-col gap-3">
          {reportPaths.length > 1 ? (
            <ReportPathPicker paths={reportPaths} activePath={activePath} onSelect={setActivePath} />
          ) : null}
          <ReportViewBody state={state} pullRequestUrl={pullRequestUrl} onOpenHtml={openHtml} />
        </div>
      </div>
    </div>
  )
}

// A path switcher for runs that produced more than one report: the kit `Select`
// (one always-selected value, arrow keys + Home/End + type-ahead, Escape, a
// single tab stop) rather than an `aria-pressed` chip pair with no keyboard
// model.
//
// Deliberately NOT a `SegmentedControl`: that control is ruled for 2–4 short
// labels (segmented-control/component.md) and its root is `inline-flex
// overflow-hidden` with no wrap, but `paths` is unbounded — a run that wrote six
// reports pushed the control straight out of the side pane, which only scrolls
// vertically. And not `Tabs` either: picking a report chooses a VALUE the pane
// then loads, it does not switch between panels that are all already there.
//
// The trigger shows the active report's basename and truncates rather than
// overflowing; the full path reads as a quiet provenance line under the control,
// on screen for everyone, with `TruncatedText` surfacing the rest in the kit
// Tooltip when the pane is too narrow for it — never a native `title=` a
// keyboard cannot reach.
export function ReportPathPicker({
  paths,
  activePath,
  onSelect,
}: {
  paths: string[]
  activePath: string | null
  onSelect: (path: string) => void
}): JSX.Element {
  const value = activePath ?? paths[0] ?? ''
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Select
        ariaLabel="Reports"
        items={paths.map((path) => ({ value: path, label: basename(path) }))}
        value={value || null}
        onChange={onSelect}
        // The side pane is narrow and scrolls only vertically: the trigger
        // truncates inside its track instead of forcing a horizontal overflow.
        className="max-w-full self-start"
        triggerMinWidthClassName="min-w-0"
      />
      {value ? (
        <TruncatedText as="p" text={value} className="font-mono text-micro text-[color:var(--text-muted)]" />
      ) : null}
    </div>
  )
}

export function ReportViewBody({
  state,
  pullRequestUrl,
  onOpenHtml,
}: {
  state: ReportViewState
  pullRequestUrl?: string
  /** Hands the active html report to the external browser; gates the confirm and re-open. */
  onOpenHtml?: () => void
}): JSX.Element {
  if (state.kind === 'loading') {
    return (
      <div className="flex items-center gap-2 py-6 text-meta text-[color:var(--text-muted)]">
        <Spinner size={14} label="Loading report" />
        Loading report…
      </div>
    )
  }

  if (state.kind === 'markdown') {
    return <div className="min-w-0">{renderMarkdown(state.markdown)}</div>
  }

  // Gate: agent-authored html can run code, so opening it is an explicit choice,
  // not the default of a single View-report click.
  if (state.kind === 'html-confirm') {
    return (
      <div className="flex flex-col items-start gap-3 py-2">
        <InlineNotice tone="warn">
          <p className="font-semibold">This report can run code</p>
          <p className="mt-0.5">
            It’s HTML written by an automation agent and opens in your external browser, where its
            scripts run with access to local files. Open it only if you trust this run.
          </p>
        </InlineNotice>
        {onOpenHtml ? <PrimaryButton onClick={onOpenHtml}>Open anyway</PrimaryButton> : null}
      </div>
    )
  }

  if (state.kind === 'html-opened') {
    return (
      <div className="flex flex-col items-start gap-3 py-6">
        <p className="text-body leading-6 text-[color:var(--text-default)]">
          This report opened in your browser.
        </p>
        {onOpenHtml ? <GhostButton onClick={onOpenHtml}>Open again</GhostButton> : null}
      </div>
    )
  }

  // Not-found has two distinct causes and only one of them is "not merged yet".
  // With a PR, the file is on the run's branch and lands here on merge. WITHOUT a
  // PR there is nothing to merge: the report path came from the agent's own prose
  // summary, so the honest reading is that the file simply is not here — most
  // often because the agent described a report it never wrote. Naming the wrong
  // cause sends the user looking for a pull request that does not exist.
  return (
    <div className="flex flex-col items-start gap-2 py-6">
      <p className="text-heading font-semibold text-[color:var(--text-strong)]">
        {pullRequestUrl ? 'This report hasn’t been merged yet' : 'This report isn’t in your workspace'}
      </p>
      <p className="max-w-md text-meta leading-5 text-[color:var(--text-muted)]">
        {pullRequestUrl
          ? 'Its file lands under reports/ once the run’s pull request merges. Until then, open the pull request to review it.'
          : 'The run’s summary named this file, but there’s no matching file under reports/ here. The agent may have described a report it didn’t write.'}
      </p>
      {pullRequestUrl ? (
        <a
          href={pullRequestUrl}
          target="_blank"
          rel="noreferrer"
          // A link is strong ink and an underline, never the accent (that is the
          // primary action's), and it carries the one focus ring like any control.
          className={`mt-1 inline-flex h-6 items-center rounded-sm px-1.5 text-meta font-medium text-[color:var(--text-strong)] underline ${FOCUS_RING_CLASS}`}
        >
          Pull request
        </a>
      ) : null}
    </div>
  )
}
