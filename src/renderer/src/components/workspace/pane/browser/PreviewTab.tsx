import React, { useCallback, useEffect, useId, useRef, useState } from 'react'

import type { PreviewPort, PreviewSummary } from '../../../../../../shared/web-client'
import { GhostButton, IconButton, PrimaryButton } from '../../../ui/Buttons'
import { EmptyState } from '../../../ui/EmptyState'
import { InlineNotice } from '../../../ui/InlineNotice'
import { Input } from '../../../ui/Input'
import { RefreshIcon } from '../../../ui/RefreshIcon'
import { Select } from '../../../ui/Select'

// The web client's preview pane (phase 9 spec, 3.6; R77): what a browser tab
// shows where the desktop shows its browser pane. It shows an agent's dev
// server, listening on the server's loopback, through a preview the server
// opens on an origin of its own: never Studio's, so the app's script cannot
// reach Studio's page or its session.
//
// The frame is sandboxed; `allow-same-origin` beside `allow-scripts` is safe
// only because the preview's origin is never Studio's. A cross-origin frame's
// navigations cannot be read, and Studio injects nothing to read them, so
// there is no back or forward, and the path field shows what the person typed.

const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads'

type Opened = { previewId: string; origin: string; port: number }

function portLabel(port: PreviewPort): string {
  const command = port.command.split(/[\\/]/).at(-1) ?? port.command
  return `${port.port} · ${command}`
}

export function PreviewTab({ active }: { active: boolean }): React.JSX.Element {
  const helpId = useId()
  const [ports, setPorts] = useState<PreviewPort[] | null>(null)
  const [typedPort, setTypedPort] = useState('')
  const [opened, setOpened] = useState<Opened | null>(null)
  const [src, setSrc] = useState<string | null>(null)
  const [path, setPath] = useState('/')
  const [error, setError] = useState<string | null>(null)
  const [frameKey, setFrameKey] = useState(0)
  const openedRef = useRef<Opened | null>(null)
  openedRef.current = opened

  const refreshPorts = useCallback(async () => {
    try {
      setPorts((await window.api.previewsList()).ports)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [])

  useEffect(() => {
    if (active) void refreshPorts()
  }, [active, refreshPorts])

  // A preview the server closed (idle, the browser removed) is gone from the pane too.
  useEffect(
    () =>
      window.api.onPreviewsChanged((previews: PreviewSummary[]) => {
        const current = openedRef.current
        if (current && !previews.some((preview) => preview.previewId === current.previewId)) {
          setOpened(null)
          setSrc(null)
        }
      }),
    [],
  )

  // The pane's preview closes with the pane.
  useEffect(
    () => () => {
      const current = openedRef.current
      if (current) void window.api.previewsClose(current.previewId).catch(() => undefined)
    },
    [],
  )

  const open = async (port: number, typed: boolean) => {
    setError(null)
    const previous = openedRef.current
    try {
      const answer = await window.api.previewsOpen({ port, typed })
      if (!answer.ok) {
        setError(answer.message)
        return
      }
      if (previous && previous.previewId !== answer.previewId) void window.api.previewsClose(previous.previewId)
      setOpened({ previewId: answer.previewId, origin: answer.origin, port })
      setPath('/')
      // The entry address spends the preview's one-time code for its cookie,
      // then lands on the app's own root.
      setSrc(answer.enterUrl)
      setFrameKey((key) => key + 1)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  const go = (target: string) => {
    if (!opened) return
    const clean = target.startsWith('/') ? target : `/${target}`
    setSrc(`${opened.origin}${clean}`)
    setFrameKey((key) => key + 1)
  }

  const portItems = (ports ?? []).map((port) => ({ value: String(port.port), label: portLabel(port) }))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[color:var(--border-subtle)] px-2 py-1.5">
        {portItems.length > 0 ? (
          <Select
            ariaLabel="Dev server"
            items={portItems}
            value={opened ? String(opened.port) : null}
            placeholder="Choose a dev server"
            onChange={(value) => void open(Number(value), false)}
          />
        ) : null}
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            const port = Number(typedPort)
            if (Number.isInteger(port)) void open(port, true)
          }}
        >
          <Input
            aria-label="Port"
            inputMode="numeric"
            placeholder="Port"
            size="xs"
            fullWidth={false}
            className="w-20"
            value={typedPort}
            onChange={(event) => setTypedPort(event.target.value.replace(/[^0-9]/gu, ''))}
          />
          <GhostButton type="submit" size="xs" disabled={typedPort === ''}>
            Open
          </GhostButton>
        </form>
        {opened ? (
          <>
            <form
              className="flex min-w-0 flex-1 items-center"
              onSubmit={(event) => {
                event.preventDefault()
                go(path)
              }}
            >
              <Input
                aria-label="Path"
                size="xs"
                spellCheck={false}
                value={path}
                onChange={(event) => setPath(event.target.value)}
              />
            </form>
            <IconButton aria-label="Reload" size="xs" onClick={() => setFrameKey((key) => key + 1)}>
              <RefreshIcon />
            </IconButton>
            <GhostButton
              size="xs"
              onClick={() => window.open(`${opened.origin}${path}`, '_blank', 'noopener,noreferrer')}
            >
              Open in a new tab
            </GhostButton>
          </>
        ) : (
          <IconButton aria-label="Refresh the list of dev servers" size="xs" onClick={() => void refreshPorts()}>
            <RefreshIcon />
          </IconButton>
        )}
      </div>
      {error ? <InlineNotice tone="error" title={error} className="m-2" /> : null}
      {src ? (
        <iframe
          key={frameKey}
          title={opened ? `Preview of port ${opened.port}` : 'Preview'}
          src={src}
          sandbox={SANDBOX}
          referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1 border-0 bg-[color:var(--bg-surface)]"
        />
      ) : (
        <EmptyState
          title={
            ports && ports.length === 0
              ? 'No agent is running a dev server yet.'
              : 'Choose a dev server to preview it here.'
          }
          body={
            <span id={helpId}>
              A preview opens on an address of its own, so the app cannot reach Studio. An app that calls localhost by
              an absolute address reaches the machine this browser runs on, not the server; use relative addresses, or
              the dev server’s own proxy.
            </span>
          }
          action={
            ports && ports.length > 0 ? (
              <PrimaryButton onClick={() => void open(ports[0].port, false)}>
                Preview {portLabel(ports[0])}
              </PrimaryButton>
            ) : null
          }
        />
      )}
    </div>
  )
}
