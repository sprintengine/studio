import { useEffect, useMemo, useState } from 'react'
import { StatusDot, Tabs, type TabItem } from '../../ui'
import type { DesignerMockupFile } from './useDesignerSession'

type Props = {
  mockups: DesignerMockupFile[]
  watchDirectoryPath: string
}

type FrameState =
  | { kind: 'loading' }
  | { kind: 'ready'; content: string }
  | { kind: 'unavailable'; reason: string }

function relativeLabel(file: DesignerMockupFile): string {
  return file.relativePath
}

function titleFromFilename(name: string): string {
  return name
    .replace(/\.html?$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

export function MockupPreviewPane({ mockups, watchDirectoryPath }: Props) {
  const [activeRelativePath, setActiveRelativePath] = useState<string | null>(null)
  const [allowScriptsByPath, setAllowScriptsByPath] = useState<Record<string, boolean>>({})

  const activeMockup = useMemo(
    () => mockups.find((m) => m.relativePath === activeRelativePath) ?? mockups[0] ?? null,
    [mockups, activeRelativePath],
  )

  useEffect(() => {
    if (!activeMockup && mockups[0]) {
      setActiveRelativePath(mockups[0].relativePath)
    }
  }, [activeMockup, mockups])

  const [frameState, setFrameState] = useState<FrameState>({ kind: 'loading' })
  const allowScripts = activeMockup ? Boolean(allowScriptsByPath[activeMockup.relativePath]) : false

  // Read the active mockup file from disk through the existing IPC. Re-read
  // when the directory changes via fs watch, when the user switches tabs,
  // or when the script toggle flips (to force a fresh iframe srcdoc).
  useEffect(() => {
    if (!activeMockup) {
      setFrameState({ kind: 'unavailable', reason: 'No mockup files yet.' })
      return
    }

    let cancelled = false
    let stopWatch: (() => Promise<void>) | null = null

    const load = async () => {
      try {
        const exists = await window.api.pathExists(activeMockup.absolutePath)
        if (cancelled) return
        if (!exists) {
          setFrameState({
            kind: 'unavailable',
            reason: `${activeMockup.relativePath} is missing on disk.`,
          })
          return
        }
        const content = await window.api.readfile(activeMockup.absolutePath)
        if (cancelled) return
        if (!content.trim()) {
          setFrameState({ kind: 'unavailable', reason: `${activeMockup.relativePath} is empty.` })
          return
        }
        setFrameState({ kind: 'ready', content })
      } catch (error) {
        if (cancelled) return
        setFrameState({
          kind: 'unavailable',
          reason:
            error instanceof Error
              ? `Could not read ${activeMockup.relativePath}: ${error.message}`
              : `Could not read ${activeMockup.relativePath}.`,
        })
      }
    }

    void load()
    void window.api
      .watchPath(watchDirectoryPath, () => {
        void load()
      })
      .then((stop) => {
        if (cancelled) {
          void stop()
          return
        }
        stopWatch = stop
      })
      .catch(() => {})

    return () => {
      cancelled = true
      if (stopWatch) void stopWatch()
    }
  }, [activeMockup, watchDirectoryPath])

  const onOpenInBrowser = async () => {
    if (!activeMockup) return
    try {
      await window.api.openHtmlFileInBrowser(activeMockup.absolutePath)
    } catch {
      // Swallow — the IPC reports its own error UI in the main process.
    }
  }

  const toggleAllowScripts = () => {
    if (!activeMockup) return
    setAllowScriptsByPath((prev) => ({
      ...prev,
      [activeMockup.relativePath]: !prev[activeMockup.relativePath],
    }))
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[13px] font-semibold text-[color:var(--text-strong)]">
            Your screens
          </span>
          <span className="inline-flex items-center gap-1.5 truncate text-[12px] text-[color:var(--text-muted)]">
            <StatusDot tone="good" />
            {mockups.length} screen{mockups.length === 1 ? '' : 's'} ready
          </span>
        </div>
        <button
          type="button"
          onClick={() => void onOpenInBrowser()}
          disabled={!activeMockup}
          className="
            inline-flex h-8 items-center rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3
            text-[12px] font-medium text-[color:var(--text-default)] transition-colors
            hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-strong)]
            disabled:cursor-not-allowed disabled:opacity-50
            focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
          "
        >
          Open in browser
        </button>
      </header>

      {mockups.length > 0 ? (
        <Tabs<string>
          ariaLabel="Mockup screens"
          items={mockups.map((mockup, index): TabItem<string> => ({
            id: mockup.relativePath,
            label: `${String(index + 1).padStart(2, '0')} · ${titleFromFilename(mockup.name)}`,
          }))}
          value={activeMockup?.relativePath ?? mockups[0]?.relativePath ?? ''}
          onChange={(id) => setActiveRelativePath(id)}
        />
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
        {activeMockup ? (
          <>
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[color:var(--border-subtle)] px-3 py-2">
              <span className="truncate font-mono text-[11px] text-[color:var(--text-muted)]">
                {relativeLabel(activeMockup)}
              </span>
              <button
                type="button"
                onClick={toggleAllowScripts}
                aria-pressed={allowScripts}
                className={`
                  inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-[11px]
                  transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
                  ${allowScripts
                    ? 'bg-[color:var(--tone-warn-soft)] text-[color:var(--tone-warn)]'
                    : 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-default)]'}
                `}
              >
                {allowScripts ? (
                  <>
                    <span aria-hidden="true">⚠</span> Scripts on
                  </>
                ) : (
                  <>Allow interactive demo</>
                )}
              </button>
            </div>
            <div className="relative min-h-0 flex-1 overflow-hidden bg-[color:var(--bg-app)]">
              {frameState.kind === 'ready' ? (
                <iframe
                  key={`${activeMockup.relativePath}::${allowScripts ? 'scripts' : 'no-scripts'}`}
                  title={`Mockup preview · ${activeMockup.relativePath}`}
                  srcDoc={frameState.content}
                  sandbox={allowScripts ? 'allow-same-origin allow-scripts' : 'allow-same-origin'}
                  className="h-full w-full border-0 bg-white"
                />
              ) : frameState.kind === 'loading' ? (
                <div className="flex h-full items-center justify-center text-[12px] text-[color:var(--text-muted)]">
                  Loading preview…
                </div>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                  <span className="text-[12px] font-semibold text-[color:var(--tone-warn)]">
                    Mockup unavailable
                  </span>
                  <span className="text-[12px] leading-5 text-[color:var(--text-muted)]">
                    {frameState.reason}
                  </span>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <span className="text-[12px] font-semibold text-[color:var(--text-strong)]">
              No mockups yet
            </span>
            <span className="text-[12px] leading-5 text-[color:var(--text-muted)]">
              The designer will write screens into the workspace’s{' '}
              <span className="font-mono">mockups/</span> folder.
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
