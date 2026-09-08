import { useEffect, useMemo, useRef, useState } from 'react'

import type { FleetLinkState, FleetTerminalAccess } from '../../../../shared/tailnet-fleet'
import { waitForMonoFontReady } from '../../utils/fonts'
import { bindTerminalClipboardHandlers } from '../../utils/terminalClipboard'
import { createStudioTerminal } from '../../utils/createStudioTerminal'
import { createTerminalFitScheduler } from '../../utils/terminalFitScheduler'
import { createXtermOutputQueue, createXtermReplayGate } from '../../utils/xtermOutputQueue'
import { StatusDot } from '../ui'
import { FOCUS_RING_TERMINAL_CLASS } from '../ui/tokens'
import { fleetInputState, fleetLinkBadge } from './fleet/fleetModel'

// One terminal on ANOTHER machine, in a pane of this one (MC-2167).
//
// The same xterm the local panes use, on the same replay gate — the difference
// is only where the bytes come from. That is the point of the item: working on
// the Mini from the laptop should be the same panes, the same terminals, one
// extra badge.
//
// The badge is not decoration. A pane that drives another computer while
// looking exactly like a local one is the failure this feature must not have,
// so the machine's name is in the pane chrome and in the tab, not in a tooltip.
//
// Reconnection is handled in main and narrated here. A dropped socket re-dials;
// the listener answers a fresh attach with the retained scrollback, which the
// replay gate repaints — so a Wi-Fi handover costs a repaint, not a screen.

interface Props {
  /** Local id for this attachment, stable for the pane's life. The event channel is keyed by it. */
  attachId: string
  connectionId: string
  /** The machine's name, for the badge. Passed in so the pane paints before any call returns. */
  machineName: string
  /** The remote session to attach to. */
  sessionId: string
}

export default function FleetTerminalPanel({ attachId, connectionId, machineName, sessionId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [link, setLink] = useState<FleetLinkState>('connecting')
  const [linkDetail, setLinkDetail] = useState<string | null>(null)
  const [access, setAccess] = useState<FleetTerminalAccess>('none')
  const [failure, setFailure] = useState<string | null>(null)
  // The terminal's onData handler is installed once; these refs are how it reads
  // the CURRENT permission instead of the one captured at mount.
  const accessRef = useRef<FleetTerminalAccess>('none')
  const linkRef = useRef<FleetLinkState>('connecting')

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // `kind: 'fleet'` carries no roots, and that is the point: this pane is
    // attached to a terminal on another machine, so a path printed in it names
    // a file over there. The surface type is what stops a later change from
    // resolving it against this machine's filesystem and opening a same-named
    // local file.
    const studioTerminal = createStudioTerminal({
      surface: { kind: 'fleet' },
      // Closed until the far end says this socket may type. Nothing is known
      // about the grant until the attach header arrives, and a cursor that
      // accepts keystrokes it will not send is a lie for that whole window.
      disableStdin: true,
    })
    const term = studioTerminal.terminal
    const fitAddon = studioTerminal.fitAddon
    term.open(container)

    const fitTerminal = () => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      fitAddon.fit()
      if (term.cols > 0 && term.rows > 0) window.api.fleetTerminalResize(attachId, term.cols, term.rows)
    }
    const focusTerminal = () => term.focus()

    fitTerminal()
    focusTerminal()
    let disposed = false
    void waitForMonoFontReady().then(() => {
      if (disposed) return
      fitTerminal()
      term.refresh(0, Math.max(0, term.rows - 1))
    })

    const outputQueue = createXtermOutputQueue(term, { recordWrite: () => {} })
    const replayGate = createXtermReplayGate(term, outputQueue)

    const applyAccess = (next: FleetTerminalAccess) => {
      accessRef.current = next
      setAccess(next)
      // xterm's own read-only mode, not just a dropped handler: a watch-only
      // pane should not blink a cursor that accepts nothing.
      term.options.disableStdin = next !== 'control'
    }
    const applyLink = (next: FleetLinkState) => {
      linkRef.current = next
      setLink(next)
    }

    // Subscribed BEFORE the attach call: the replay is the first frame the
    // listener sends, and a subscription placed after the await would miss the
    // screen this pane exists to show.
    const disposeEvents = window.api.onFleetTerminalEvent(attachId, (event) => {
      switch (event.type) {
        case 'status':
          applyLink(event.state)
          setLinkDetail(event.detail || null)
          // A recovered link clears the last failure: leaving "that machine is
          // not answering" over a working terminal is a stale claim, and this
          // strip is the only place the pane makes claims.
          if (event.state === 'live') setFailure(null)
          // Deliberately NOT re-arming the replay wait here. The gate treats a
          // replay that arrives while it is NOT waiting, on a terminal that has
          // already painted, as a resync: it resets the stale screen and repaints
          // from the retained scrollback. Arming the wait would make the
          // reconnect's replay append instead, doubling the scrollback.
          if (event.state === 'closed') replayGate.finishReplayWait()
          break
        case 'attached':
          applyAccess(event.access)
          break
        case 'replay':
          replayGate.handleReplay(event.data)
          break
        case 'output':
          replayGate.handleLiveData(event.data)
          break
        case 'exit':
          term.write(`\r\n\x1b[31m[Remote terminal exited with code ${event.exitCode}]\x1b[0m\r\n`)
          break
        case 'ended':
          term.write(`\r\n\x1b[31m[${event.reason}]\x1b[0m\r\n`)
          break
        case 'error':
          setFailure(event.message)
          break
      }
    })

    replayGate.beginReplayWait()
    void window.api
      .fleetAttachTerminal({ attachId, connectionId, sessionId })
      .then((result) => {
        if (disposed) return
        if (!result.ok) {
          setFailure(result.message)
          applyLink('closed')
          return
        }
        // The pane fitted itself before the attachment existed, so that first
        // resize was dropped. Send it now: the size is held and replayed on
        // every (re)connect, and without it the remote pty renders to whatever
        // width the last viewer had.
        window.api.fleetTerminalResize(attachId, term.cols, term.rows)
      })
      .catch((error: unknown) => {
        if (disposed) return
        setFailure(error instanceof Error ? error.message : 'Could not attach to that terminal.')
        applyLink('closed')
      })

    const onDataDisposable = term.onData((data) => {
      // Refused here as well as at the far end. The listener drops an
      // observe-scoped input frame and says so, but a keystroke that leaves this
      // machine before being refused is a keystroke a person believes landed.
      if (!fleetInputState(accessRef.current, linkRef.current).canType) return
      window.api.fleetTerminalInput(attachId, data)
    })
    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      window.api.fleetTerminalResize(attachId, cols, rows)
    })

    const fitScheduler = createTerminalFitScheduler(fitTerminal, container)
    const resizeObserver = new ResizeObserver(() => fitScheduler.requestFit())
    resizeObserver.observe(container)
    container.addEventListener('mousedown', focusTerminal)
    container.addEventListener('click', focusTerminal)
    const disposeClipboardHandlers = bindTerminalClipboardHandlers({
      container,
      term,
      sessionId: attachId,
      focusTerminal,
      // Paste reaches the remote pty through the same guarded path as typing.
      write: (data) => {
        if (!fleetInputState(accessRef.current, linkRef.current).canType) return
        window.api.fleetTerminalInput(attachId, data)
      },
    })

    return () => {
      disposed = true
      resizeObserver.disconnect()
      fitScheduler.dispose()
      container.removeEventListener('mousedown', focusTerminal)
      container.removeEventListener('click', focusTerminal)
      disposeClipboardHandlers()
      onDataDisposable.dispose()
      onResizeDisposable.dispose()
      disposeEvents()
      replayGate.dispose()
      outputQueue.dispose()
      // Last: it unbinds the theme and disposes the terminal itself, so nothing
      // above may still be reading `term`.
      studioTerminal.dispose()
      // The socket is main's, and it is this pane's alone: closing the pane ends
      // the attachment rather than leaving a remote pty narrating to nobody.
      void window.api.fleetDetachTerminal(attachId).catch(() => {})
    }
  }, [attachId, connectionId, sessionId])

  const badge = useMemo(() => fleetLinkBadge(link, linkDetail), [link, linkDetail])
  const input = useMemo(() => fleetInputState(access, link), [access, link])

  return (
    <div className="flex h-full flex-col bg-[color:var(--bg-app)]">
      <div className="flex items-center gap-2 border-b border-[color:var(--border-subtle)] px-2.5 py-1.5">
        <StatusDot tone={badge.tone} />
        <span className="truncate text-meta font-medium text-[color:var(--text-strong)]">{machineName}</span>
        <span className="text-meta text-[color:var(--text-muted)]">{badge.label}</span>
        {input.label ? (
          <span className="ml-auto truncate text-meta text-[color:var(--text-muted)]">{input.label}</span>
        ) : null}
      </div>
      {failure ?? badge.detail ? (
        <p
          aria-live="polite"
          className="border-b border-[color:var(--border-subtle)] px-2.5 py-1 text-meta text-[color:var(--text-muted)]"
        >
          {failure ?? badge.detail}
        </p>
      ) : null}
      <div className="relative min-h-0 flex-1">
        <div
          ref={containerRef}
          tabIndex={0}
          className={`${FOCUS_RING_TERMINAL_CLASS} absolute inset-0 cursor-text overflow-hidden p-2 pb-4`}
        />
      </div>
    </div>
  )
}
