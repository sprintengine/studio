import { useEffect, useMemo, useRef, useState } from 'react'

import type { FleetLinkState, FleetTerminalAccess } from '../../../../shared/tailnet-fleet'
import { waitForMonoFontReady } from '../../utils/fonts'
import { bindTerminalClipboardHandlers } from '../../utils/terminalClipboard'
import { createStudioTerminal, type StudioTerminal } from '../../utils/createStudioTerminal'
import { useTerminalFind } from '../../hooks/useTerminalFind'
import { isTerminalChromeTarget, TERMINAL_SURFACE_ATTRIBUTE } from '../../utils/keyboard'
import { TerminalFindBar } from '../terminal/TerminalFindBar'
import { createTerminalFitScheduler } from '../../utils/terminalFitScheduler'
import { createXtermOutputQueue, createXtermReplayGate } from '../../utils/xtermOutputQueue'
import { StatusDot } from '../ui'
import { CursorErrorPopover } from '../ui/CursorErrorPopover'
import { TerminalMount } from '../terminal/TerminalMount'
import { FOCUS_RING_TERMINAL_CLASS } from '../ui/tokens'
import { TerminalLinkMenu } from '../terminal/TerminalLinkMenu'
import type { TerminalLinkTarget } from '../../utils/terminalLinkActions'
import { fleetInputState, fleetLinkBadge } from './fleet/fleetModel'

// One terminal on ANOTHER machine, in a pane of this one (MC-2167).
//
// The same xterm the local panes use, on the same replay gate — the difference
// is only where the bytes come from. That is the point of the item: working on
// the Mini from the laptop should be the same panes, the same terminals.
//
// The pane carries NO standing chrome of its own (owner, 2026-09-11). It used
// to open on a permanent bar — a status dot, the machine's full tailnet name,
// and the word "Live" — above every remote terminal. The tab above it already
// names the machine, so the bar restated that on every line of output and spent
// a row of the pane saying "this is working" while it was working.
//
// What it says now is only what is WRONG: a link that is not live, a pairing
// that may not type, a failure. A healthy pane is terminal, edge to edge, the
// same as a local one. Provenance did not go to a tooltip — it is on the tab
// chip, where it does not repeat.
//
// Reconnection is handled in main and narrated here. A dropped socket re-dials;
// the listener answers a fresh attach with the retained scrollback, which the
// replay gate repaints — so a Wi-Fi handover costs a repaint, not a screen.

interface Props {
  /** Local id for this attachment, stable for the pane's life. The event channel is keyed by it. */
  attachId: string
  connectionId: string
  /**
   * The workspace this pane is rendered in. Not a resolution root — a fleet
   * pane resolves no local path at all — only where a chosen link action lands
   * (a browser tab, the clipboard).
   */
  workspaceId: string
  /**
   * The machine's name. The pane no longer draws it — the tab chip does — but
   * it stays on the props because the layout config that mounts this pane
   * stores it, and a pane that dropped it could not put it back on a tab.
   */
  machineName: string
  /** The remote session to attach to. */
  sessionId: string
}

export default function FleetTerminalPanel({ attachId, connectionId, sessionId, workspaceId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  // The padding-free box xterm is opened into; see TerminalMount.
  const terminalMountRef = useRef<HTMLDivElement>(null)
  // The live terminal, for anything outside the mount effect that needs it —
  // today `useTerminalFind`, which loads the search addon on the first find.
  const studioTerminalRef = useRef<StudioTerminal | null>(null)
  // No workspace id: this pane is attached to a MACHINE, not to a folder. It
  // answers Find only while it holds focus, never through the active-workspace
  // fallback, which would be answering for a workspace it is not part of.
  const find = useTerminalFind({ workspaceId: null, containerRef, terminalRef: studioTerminalRef })
  const [link, setLink] = useState<FleetLinkState>('connecting')
  const [linkDetail, setLinkDetail] = useState<string | null>(null)
  const [access, setAccess] = useState<FleetTerminalAccess>('none')
  const [failure, setFailure] = useState<string | null>(null)
  const [linkMenu, setLinkMenu] = useState<{ target: TerminalLinkTarget; x: number; y: number } | null>(null)
  const [linkError, setLinkError] = useState<{ message: string; x: number; y: number } | null>(null)
  // The terminal's onData handler is installed once; these refs are how it reads
  // the CURRENT permission instead of the one captured at mount.
  const accessRef = useRef<FleetTerminalAccess>('none')
  const linkRef = useRef<FleetLinkState>('connecting')

  useEffect(() => {
    const container = containerRef.current
    const mount = terminalMountRef.current
    if (!container || !mount) return

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
      // A pane with no `oscLinks` used to be a pane with no gate: xterm
      // registers its `OscLinkProvider` unconditionally, and with no
      // `linkHandler` to consult it falls back to its own `defaultActivate` —
      // a raw browser confirmation dialog and a `window.open()`, which this
      // app's `setWindowOpenHandler` turns into `shell.openExternal`. An http(s)
      // hyperlink printed by the REMOTE machine therefore opened in the user's
      // real browser without passing `resolveTerminalOscLink` or this chooser.
      // `createStudioTerminal` now derives the gate from `surface`, so the
      // fleet rule holds here by construction rather than by remembering.
      oscLinks: {
        // Unreachable: a fleet surface has no link roots, so
        // `resolveTerminalOscLink` never returns a `file` target for it. Kept
        // fail-closed rather than thrown, so a future surface change degrades
        // to "that file does not exist" instead of opening a same-named local
        // file.
        inspectPath: async () => ({ exists: false, isDirectory: false }),
        onActivateFile: () => {},
        onActivateUrl: (url, anchor) => {
          setLinkMenu({ target: { kind: 'url', url }, x: anchor.x, y: anchor.y })
        },
        onOpenError: (message, anchor) => setLinkError({ message, x: anchor.x, y: anchor.y }),
      },
    })
    studioTerminalRef.current = studioTerminal
    const term = studioTerminal.terminal
    const fitAddon = studioTerminal.fitAddon
    term.open(mount)
    // Immediately after `open()`: the WebGL addon reads `term.element`, and a
    // GPU failure loaded before that point escapes through `open()` itself.
    studioTerminal.loadWebglRenderer()

    const fitTerminal = () => {
      if (mount.clientWidth === 0 || mount.clientHeight === 0) return
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

    const fitScheduler = createTerminalFitScheduler(fitTerminal, mount)
    const resizeObserver = new ResizeObserver(() => fitScheduler.requestFit())
    resizeObserver.observe(mount)
    // A pointer landing on the pane's own chrome (the find bar) is not a click
    // on the terminal: focusing here would take the keyboard straight back out
    // of the find field.
    const focusTerminalFromPointer = (event: Event) => {
      if (isTerminalChromeTarget(event.target)) return
      focusTerminal()
    }
    container.addEventListener('mousedown', focusTerminalFromPointer)
    container.addEventListener('click', focusTerminalFromPointer)
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
      container.removeEventListener('mousedown', focusTerminalFromPointer)
      container.removeEventListener('click', focusTerminalFromPointer)
      disposeClipboardHandlers()
      onDataDisposable.dispose()
      onResizeDisposable.dispose()
      disposeEvents()
      replayGate.dispose()
      outputQueue.dispose()
      studioTerminalRef.current = null
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

  // The one line the pane may draw, and only when there is something wrong to
  // say: the failure, then the link's own sentence, then the reason typing is
  // refused. A live pane a person can type into says nothing at all.
  const notice = failure ?? badge.detail ?? input.label
  return (
    <div className="flex h-full flex-col bg-[color:var(--bg-app)]">
      {notice ? (
        <p
          aria-live="polite"
          className="flex items-center gap-2 border-b border-[color:var(--border-subtle)] px-2.5 py-1 text-meta text-[color:var(--text-muted)]"
        >
          {/* The dot rides the sentence rather than a bar of its own — it is
              the tone of what is being said, not a standing readout. */}
          <StatusDot tone={badge.tone} />
          <span className="min-w-0 flex-1 truncate">{notice}</span>
        </p>
      ) : null}
      <div className="relative min-h-0 flex-1">
        <div
          ref={containerRef}
          tabIndex={0}
          className={`${FOCUS_RING_TERMINAL_CLASS} absolute inset-0 cursor-text overflow-hidden p-2`}
          // Marks this as a terminal surface, so a ⌘F pressed anywhere in it —
          // including in the find bar — activates the `terminal` command scope.
          {...{ [TERMINAL_SURFACE_ATTRIBUTE]: '' }}
        >
          <TerminalMount ref={terminalMountRef} />
          <TerminalFindBar find={find} />
        </div>
        {linkError ? (
          <CursorErrorPopover
            key={`${linkError.x},${linkError.y},${linkError.message}`}
            message={linkError.message}
            anchor={{ x: linkError.x, y: linkError.y }}
            onDismiss={() => setLinkError(null)}
          />
        ) : null}
        {linkMenu ? (
          <TerminalLinkMenu
            workspaceId={workspaceId}
            target={linkMenu.target}
            x={linkMenu.x}
            y={linkMenu.y}
            onClose={() => setLinkMenu(null)}
            onError={(message) => setLinkError({ message, x: linkMenu.x, y: linkMenu.y })}
          />
        ) : null}
      </div>
    </div>
  )
}
