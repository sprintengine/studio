import React, { useCallback, useEffect, useState } from 'react'

import { Drawer, GhostButton, Spinner } from '../ui'
import { renderMarkdown } from '../../utils/markdown'
import { basename, joinFilePath } from '../../utils/paths'

// In-app viewer for a single automation run's report. The run owns the report
// link (T4 threads `onViewReport(run)`); this overlay reads and renders it.
//
// Reports are markdown or html files committed under `reports/`. The paths are
// already validated upstream (contained under `reports/`, project-relative) —
// this component only resolves them under `workspaceRoot` for the read:
//   - `.md`   → read + render inline via renderMarkdown()
//   - `.html` → open in the system browser (not inlined)
//   - a read/open failure (most commonly: the report's PR hasn't merged, so the
//     file isn't on this checkout yet) → an explicit not-found state that
//     surfaces the run's Pull request link as the way forward.

export type ReportFilesystem = {
  readfile: (path: string) => Promise<string>
  openHtmlFileInBrowser: (targetPath: string) => Promise<void>
}

export type ReportViewState =
  | { kind: 'loading' }
  | { kind: 'markdown'; markdown: string }
  | { kind: 'html' }
  | { kind: 'not-found' }

/** An html report opens in the browser; everything else renders inline. */
export function isHtmlReport(reportPath: string): boolean {
  return /\.html$/i.test(reportPath)
}

// Pure data layer: resolve one report path to a terminal view state. Kept
// separate from React so the read/open branches are asserted directly against a
// stubbed filesystem rather than through rendered effects.
export async function loadReportContent(
  fs: ReportFilesystem,
  workspaceRoot: string,
  reportPath: string,
): Promise<ReportViewState> {
  const target = joinFilePath(workspaceRoot, reportPath)
  if (isHtmlReport(reportPath)) {
    try {
      await fs.openHtmlFileInBrowser(target)
      return { kind: 'html' }
    } catch {
      return { kind: 'not-found' }
    }
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

  // Load the active report; re-runs when the user picks a different one. An html
  // pick re-opens it in the browser (the load itself is the side effect).
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

  const reopenHtml = useCallback(() => {
    if (activePath) void window.api.openHtmlFileInBrowser(joinFilePath(workspaceRoot, activePath))
  }, [activePath, workspaceRoot])

  const title = reportPaths.length > 1 ? 'Run reports' : activePath ? basename(activePath) : 'Run report'

  return (
    <Drawer open onClose={onClose} title={title} ariaLabel="Automation run report" width={640}>
      <Drawer.Body className="flex flex-col gap-3">
        {reportPaths.length > 1 ? (
          <ReportPathPicker paths={reportPaths} activePath={activePath} onSelect={setActivePath} />
        ) : null}
        <ReportViewBody state={state} pullRequestUrl={pullRequestUrl} onReopenHtml={reopenHtml} />
      </Drawer.Body>
    </Drawer>
  )
}

// A compact path switcher for runs that produced more than one report. The
// active path carries the single accent; the rest are quiet until hovered —
// mirroring the Automations view-tab idiom.
export function ReportPathPicker({
  paths,
  activePath,
  onSelect,
}: {
  paths: string[]
  activePath: string | null
  onSelect: (path: string) => void
}): JSX.Element {
  return (
    <div role="group" aria-label="Reports" className="flex flex-wrap gap-1">
      {paths.map((path) => {
        const active = path === activePath
        return (
          <button
            key={path}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(path)}
            title={path}
            className={[
              'h-6 rounded px-2 text-[11px] font-medium outline-none transition-colors focus-visible:ring-1 focus-visible:ring-[color:var(--accent-primary)]',
              active
                ? 'bg-[color:var(--accent-primary-soft)] text-[color:var(--text-strong)]'
                : 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)]',
            ].join(' ')}
          >
            {basename(path)}
          </button>
        )
      })}
    </div>
  )
}

export function ReportViewBody({
  state,
  pullRequestUrl,
  onReopenHtml,
}: {
  state: ReportViewState
  pullRequestUrl?: string
  onReopenHtml?: () => void
}): JSX.Element {
  if (state.kind === 'loading') {
    return (
      <div className="flex items-center gap-2 py-6 text-[12px] text-[color:var(--text-muted)]">
        <Spinner size={14} label="Loading report" />
        Loading report…
      </div>
    )
  }

  if (state.kind === 'markdown') {
    return <div className="min-w-0">{renderMarkdown(state.markdown)}</div>
  }

  if (state.kind === 'html') {
    return (
      <div className="flex flex-col items-start gap-3 py-6">
        <p className="text-[13px] leading-6 text-[color:var(--text-default)]">
          This report opened in your browser.
        </p>
        {onReopenHtml ? <GhostButton onClick={onReopenHtml}>Open again</GhostButton> : null}
      </div>
    )
  }

  return (
    <div className="flex flex-col items-start gap-2 py-6">
      <p className="text-[14px] font-semibold text-[color:var(--text-strong)]">
        This report hasn’t been merged yet
      </p>
      <p className="max-w-md text-[12px] leading-5 text-[color:var(--text-muted)]">
        Its file lands under reports/ once the run’s pull request merges. Until then, open the pull
        request to review it.
      </p>
      {pullRequestUrl ? (
        <a
          href={pullRequestUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-flex h-6 items-center rounded px-1.5 text-[12px] font-medium text-[color:var(--accent-primary)] hover:underline"
        >
          Pull request
        </a>
      ) : null}
    </div>
  )
}
