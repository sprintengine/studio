import { hostname } from 'os'

import { backoffDelayMs } from '../../../shared/exponentialBackoff'
import type { TailnetScope } from '../../../shared/tailnet'
import {
  fleetTerminalAccess,
  type FleetAttachResult,
  type FleetBrowse,
  type FleetConnection,
  type FleetCreateTerminalResult,
  type FleetGap,
  type FleetPairResult,
  type FleetRun,
  type FleetTerminal,
  type FleetTerminalEvent,
  type FleetWorkspace,
} from '../../../shared/tailnet-fleet'
import { createTailnetFleetStore, type StoredFleetConnection, type TailnetFleetStore } from './tailnet-fleet-store'
import {
  callRemoteTool,
  formatTailnetEndpoint,
  openRemoteTerminalSocket,
  pairWithMachine,
  parsePairingUrl,
  parseTailnetEndpoint,
  readRemoteIdentity,
  type RemoteTerminalSocket,
} from './tailnet-remote-client'

// The Fleet: this Studio driving other machines (MC-2167).
//
// Everything a window needs to work "on the Mini from the laptop" — the paired
// machines, what they hold, and the terminals open on them — with the tokens
// and the sockets kept in main. A window sends keystrokes and receives frames;
// it never holds a credential and never opens a connection.
//
// The reconnect loop is the part that earns its keep. A laptop lid closing, a
// Wi-Fi handover, a peer that sleeps: none of them are errors, and none of them
// should cost a person their scrollback. A dropped socket re-dials, and the
// listener answers a fresh attach with a `replay` — the retained scrollback,
// which is a superset of whatever was missed — so the pane repaints rather than
// showing a hole.

/** First retry is fast (a Wi-Fi blip), then backs off to a quiet poll for a sleeping peer. */
const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 15_000
/** After this many failed dials the pane stops saying "reconnecting" and says the peer is not answering. */
const OFFLINE_AFTER_ATTEMPTS = 3

export type TailnetFleetService = {
  listConnections(): FleetConnection[]
  pair(input: { pairingUrl: unknown; deviceName?: unknown }): Promise<FleetPairResult>
  forget(connectionId: unknown): FleetConnection[]
  browse(connectionId: unknown): Promise<FleetBrowse>
  listRuns(
    connectionId: unknown,
    workspaceId: unknown
  ): Promise<{ ok: true; runs: FleetRun[] } | { ok: false; code: string; message: string }>
  createTerminal(input: {
    connectionId: unknown
    workspaceId?: unknown
    name?: unknown
  }): Promise<FleetCreateTerminalResult>
  /**
   * Attach a pane to a remote session. `emit` is the pane's event sink; the
   * caller owns its lifetime and calls `detach` when the pane goes away.
   */
  attachTerminal(input: {
    attachId: string
    connectionId: unknown
    sessionId: unknown
    emit: (event: FleetTerminalEvent) => void
  }): Promise<FleetAttachResult>
  sendInput(attachId: unknown, data: unknown): void
  resizeTerminal(attachId: unknown, cols: unknown, rows: unknown): void
  detachTerminal(attachId: unknown): void
  shutdown(): void
}

export type TailnetFleetServiceOptions = {
  resolveUserDataDir: () => string
  /** This machine's name, as the other end will list the pairing. */
  resolveDeviceName?: () => string
  /** Tailscale node name for an address, so a machine is listed by name rather than by IP. */
  resolvePeerName?: (address: string) => Promise<string | null>
  createStore?: (options: { resolveUserDataDir: () => string; log?: (message: string) => void }) => TailnetFleetStore
  log?: (message: string) => void
}

type Attachment = {
  attachId: string
  connectionId: string
  sessionId: string
  emit: (event: FleetTerminalEvent) => void
  socket: RemoteTerminalSocket | null
  /** Set once the pane detaches, so an in-flight reconnect stops instead of resurrecting it. */
  released: boolean
  /** Whether THIS dial got as far as an attach header; reset on every dial. */
  attachedThisDial: boolean
  /** The last refusal the far end sent on this dial, if any. */
  refusalThisDial: string | null
  attempts: number
  retryTimer: ReturnType<typeof setTimeout> | null
  /** Last known size, replayed after a reconnect so the remote pty matches the pane. */
  size: { cols: number; rows: number } | null
}

export function createTailnetFleetService(options: TailnetFleetServiceOptions): TailnetFleetService {
  const store = (options.createStore ?? createTailnetFleetStore)({
    resolveUserDataDir: options.resolveUserDataDir,
    log: options.log,
  })
  const deviceName = () => (options.resolveDeviceName ?? defaultDeviceName)()
  const attachments = new Map<string, Attachment>()

  function connectionFor(connectionId: unknown): StoredFleetConnection | null {
    return typeof connectionId === 'string' ? store.find(connectionId) : null
  }

  async function pair(input: { pairingUrl: unknown; deviceName?: unknown }): Promise<FleetPairResult> {
    const raw = typeof input.pairingUrl === 'string' ? input.pairingUrl : ''
    const parsed = parsePairingUrl(raw)
    if (!parsed) {
      return {
        ok: false,
        code: 'invalid_pairing_link',
        message: 'That is not a pairing link. Copy the whole link from the other machine\'s Settings → Remote.',
      }
    }
    const name = typeof input.deviceName === 'string' && input.deviceName.trim() ? input.deviceName.trim() : deviceName()
    if (!name) {
      return {
        ok: false,
        code: 'device_name_required',
        message: 'This machine has no name to pair under. Name it and try again.',
      }
    }
    const paired = await pairWithMachine({
      endpoint: parsed.endpoint,
      pairingToken: parsed.pairingToken,
      deviceName: name,
    })
    if (!paired.ok) return { ok: false, code: paired.code, message: paired.message }

    // Named by Tailscale where it can be — an address is a correct label and a
    // useless one. The address stays as the fallback rather than an invented name.
    const peerName = (await options.resolvePeerName?.(parsed.endpoint.host).catch(() => null)) ?? null
    try {
      const connection = store.add({
        machineName: peerName ?? parsed.endpoint.host,
        endpoint: formatTailnetEndpoint(parsed.endpoint),
        deviceId: paired.value.deviceId,
        deviceName: paired.value.deviceName,
        deviceToken: paired.value.deviceToken,
        scopes: paired.value.scopes,
      })
      return { ok: true, connection }
    } catch (error) {
      // The device now exists on the other machine. Saying "paired" over a token
      // we could not keep would leave a live grant nothing here can name — so
      // say exactly what happened and what to do about it.
      return {
        ok: false,
        code: 'pairing_not_saved',
        message:
          `Paired with ${formatTailnetEndpoint(parsed.endpoint)}, but the credential could not be saved here `
          + `(${message(error)}). Revoke this device on that machine and pair again.`,
      }
    }
  }

  async function browse(connectionId: unknown): Promise<FleetBrowse> {
    const connection = connectionFor(connectionId)
    if (!connection) return unknownConnectionBrowse(connectionId)

    // Identity first: it is the cheapest authenticated call, so it separates
    // "asleep" from "revoked" before anything else is attempted, and it returns
    // the scopes as they are NOW rather than as they were at pairing.
    const identity = await readRemoteIdentity({ endpoint: endpointOf(connection), token: connection.deviceToken })
    if (!identity.ok) {
      return {
        connectionId: connection.id,
        reachable: false,
        unreachableReason: identity.message,
        unauthorized: identity.code === 'unauthorized',
        scopes: connection.scopes,
        terminalAccess: fleetTerminalAccess(connection.scopes),
        workspaces: [],
        terminals: [],
        gaps: [],
      }
    }
    store.updateScopes(connection.id, identity.value.scopes)
    store.markConnected(connection.id)
    const scopes = identity.value.scopes

    const gaps: FleetGap[] = []
    const [workspaces, terminals] = await Promise.all([
      readWorkspaces(connection, scopes, gaps),
      readTerminals(connection, scopes, gaps),
    ])

    return {
      connectionId: connection.id,
      reachable: true,
      unreachableReason: null,
      unauthorized: false,
      scopes,
      terminalAccess: fleetTerminalAccess(scopes),
      workspaces,
      terminals,
      gaps,
    }
  }

  async function readWorkspaces(
    connection: StoredFleetConnection,
    scopes: TailnetScope[],
    gaps: FleetGap[]
  ): Promise<FleetWorkspace[]> {
    // Asked for only when the grant allows it. A refusal is a real answer and is
    // reported as one — an empty list would say "that machine has no
    // workspaces", which is a different and false statement.
    if (!scopes.some((scope) => scope.startsWith('workspace:'))) {
      gaps.push({
        part: 'workspaces',
        code: 'scope_required',
        message: 'This pairing may not read that machine\'s workspaces.',
      })
      return []
    }
    const answer = await callRemoteTool({
      endpoint: endpointOf(connection),
      token: connection.deviceToken,
      tool: 'workspace.list',
    })
    if (!answer.ok) {
      gaps.push({ part: 'workspaces', code: answer.code, message: answer.message })
      return []
    }
    const entries = Array.isArray(answer.value.workspaces) ? answer.value.workspaces : []
    return entries.flatMap((entry) => {
      const record = asRecord(entry)
      if (!record || typeof record.id !== 'string') return []
      return [
        {
          id: record.id,
          name: typeof record.name === 'string' ? record.name : record.id,
          mode: typeof record.mode === 'string' ? record.mode : null,
          folderPath: typeof record.folderPath === 'string' ? record.folderPath : null,
        },
      ]
    })
  }

  async function readTerminals(
    connection: StoredFleetConnection,
    scopes: TailnetScope[],
    gaps: FleetGap[]
  ): Promise<FleetTerminal[]> {
    if (fleetTerminalAccess(scopes) === 'none') {
      gaps.push({
        part: 'terminals',
        code: 'scope_required',
        message: 'This pairing may not see that machine\'s terminals. Pair again with a terminal scope.',
      })
      return []
    }
    const answer = await callRemoteTool({
      endpoint: endpointOf(connection),
      token: connection.deviceToken,
      tool: 'terminal.list',
    })
    if (!answer.ok) {
      gaps.push({ part: 'terminals', code: answer.code, message: answer.message })
      return []
    }
    const entries = Array.isArray(answer.value.terminals) ? answer.value.terminals : []
    return entries.flatMap((entry) => {
      const record = asRecord(entry)
      if (!record || typeof record.sessionId !== 'string') return []
      const state = asRecord(record.agentState)
      return [
        {
          sessionId: record.sessionId,
          kind: record.kind === 'agent' ? 'agent' : 'terminal',
          workspaceId: typeof record.workspaceId === 'string' ? record.workspaceId : null,
          agentName: typeof record.agentName === 'string' ? record.agentName : null,
          cli: typeof record.cli === 'string' ? record.cli : null,
          cwd: typeof record.cwd === 'string' ? record.cwd : null,
          processAlive: record.processAlive === true,
          suspended: record.suspended === true,
          phase: typeof state?.phase === 'string' ? state.phase : null,
        },
      ]
    })
  }

  async function listRuns(
    connectionId: unknown,
    workspaceId: unknown
  ): Promise<{ ok: true; runs: FleetRun[] } | { ok: false; code: string; message: string }> {
    const connection = connectionFor(connectionId)
    if (!connection) return { ok: false, code: 'unknown_connection', message: 'That machine is not paired here.' }
    if (typeof workspaceId !== 'string' || !workspaceId) {
      return { ok: false, code: 'invalid_arguments', message: 'Name the workspace whose runs to list.' }
    }
    const answer = await callRemoteTool({
      endpoint: endpointOf(connection),
      token: connection.deviceToken,
      tool: 'sprint.list',
      args: { workspaceId },
    })
    if (!answer.ok) return { ok: false, code: answer.code, message: answer.message }
    const entries = Array.isArray(answer.value.runs) ? answer.value.runs : []
    return {
      ok: true,
      runs: entries.flatMap((entry) => {
        const record = asRecord(entry)
        if (!record || typeof record.slug !== 'string') return []
        return [{ slug: record.slug, statePath: typeof record.statePath === 'string' ? record.statePath : '' }]
      }),
    }
  }

  async function createTerminal(input: {
    connectionId: unknown
    workspaceId?: unknown
    name?: unknown
  }): Promise<FleetCreateTerminalResult> {
    const connection = connectionFor(input.connectionId)
    if (!connection) return { ok: false, code: 'unknown_connection', message: 'That machine is not paired here.' }
    const answer = await callRemoteTool({
      endpoint: endpointOf(connection),
      token: connection.deviceToken,
      tool: 'terminal.create',
      args: {
        ...(typeof input.workspaceId === 'string' && input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(typeof input.name === 'string' && input.name ? { name: input.name } : {}),
      },
      // A launch waits on a real CLI starting on another machine; the default
      // read timeout would call a healthy slow start a failure.
      timeoutMs: 60_000,
    })
    if (!answer.ok) return { ok: false, code: answer.code, message: answer.message }
    const sessionId = typeof answer.value.sessionId === 'string' ? answer.value.sessionId : ''
    if (!sessionId) {
      return {
        ok: false,
        code: 'unreadable_result',
        message: 'That machine opened a terminal but did not say which session it is, so it cannot be attached.',
      }
    }
    const terminal = asRecord(answer.value.terminal)
    return {
      ok: true,
      sessionId,
      workspaceId: typeof answer.value.workspaceId === 'string' ? answer.value.workspaceId : '',
      agentId: typeof answer.value.agentId === 'string' ? answer.value.agentId : '',
      title: typeof terminal?.agentName === 'string' && terminal.agentName ? terminal.agentName : 'Terminal',
    }
  }

  async function attachTerminal(input: {
    attachId: string
    connectionId: unknown
    sessionId: unknown
    emit: (event: FleetTerminalEvent) => void
  }): Promise<FleetAttachResult> {
    const connection = connectionFor(input.connectionId)
    if (!connection) return { ok: false, code: 'unknown_connection', message: 'That machine is not paired here.' }
    if (typeof input.sessionId !== 'string' || !input.sessionId) {
      return { ok: false, code: 'invalid_arguments', message: 'Name the terminal session to attach to.' }
    }
    // Re-attaching the same pane replaces the old attachment rather than
    // stacking a second socket on the same session id.
    detachTerminal(input.attachId)

    const attachment: Attachment = {
      attachId: input.attachId,
      connectionId: connection.id,
      sessionId: input.sessionId,
      emit: input.emit,
      socket: null,
      released: false,
      attachedThisDial: false,
      refusalThisDial: null,
      attempts: 0,
      retryTimer: null,
      size: null,
    }
    attachments.set(input.attachId, attachment)
    void dial(attachment)
    return { ok: true }
  }

  /** One connect attempt, and the retry schedule when it does not stick. */
  async function dial(attachment: Attachment): Promise<void> {
    if (attachment.released) return
    const connection = store.find(attachment.connectionId)
    if (!connection) {
      finish(attachment, 'That machine is no longer paired here.')
      return
    }
    attachment.attachedThisDial = false
    attachment.refusalThisDial = null
    attachment.emit({
      type: 'status',
      state: attachment.attempts === 0 ? 'connecting' : 'reconnecting',
      detail:
        attachment.attempts === 0
          ? `Connecting to ${connection.machineName}.`
          : `Reconnecting to ${connection.machineName}.`,
    })

    const opened = await openRemoteTerminalSocket({
      endpoint: endpointOf(connection),
      token: connection.deviceToken,
      sessionId: attachment.sessionId,
      handlers: {
        onFrame: (frame) => handleFrame(attachment, frame),
        onClosed: ({ code, reason }) => {
          attachment.socket = null
          // A revoked device (4401) is a decision someone made, not a blip:
          // retrying would be a loop against a door that has been locked.
          if (code === 4401) {
            finish(attachment, reason)
            return
          }
          // Neither is a socket the far end opened and then refused — an
          // attach for a session that does not exist there, say, which a
          // restored layout will ask for every time. It closes cleanly, so
          // without this it would look exactly like a network blip and retry
          // forever against something that will never be there.
          if (!attachment.attachedThisDial && attachment.refusalThisDial) {
            finish(attachment, attachment.refusalThisDial)
            return
          }
          scheduleRetry(attachment, reason)
        },
      },
    })

    if (attachment.released) {
      if (opened.ok) opened.value.close('The pane was closed.')
      return
    }
    if (!opened.ok) {
      // A refusal that will not change on retry is reported and ended; anything
      // that looks like a network is retried.
      if (opened.code === 'unauthorized' || opened.code.startsWith('terminal_')) {
        attachment.emit({ type: 'error', code: opened.code, message: opened.message })
        finish(attachment, opened.message)
        return
      }
      scheduleRetry(attachment, opened.message)
      return
    }

    attachment.socket = opened.value
    attachment.attempts = 0
    store.markConnected(connection.id)
    attachment.emit({ type: 'status', state: 'live', detail: `Connected to ${connection.machineName}.` })
    // The remote pty is sized for whichever pane attached last; re-sending this
    // pane's size after a reconnect is what stops a resumed session rendering to
    // a stale width.
    if (attachment.size) {
      opened.value.send({ type: 'resize', cols: attachment.size.cols, rows: attachment.size.rows })
    }
  }

  function handleFrame(attachment: Attachment, frame: Record<string, unknown>): void {
    if (attachment.released) return
    const type = frame.type
    if (type === 'replay' && typeof frame.data === 'string') {
      attachment.emit({ type: 'replay', data: frame.data, reason: frame.reason === 'resync' ? 'resync' : 'attach' })
      return
    }
    if (type === 'output' && typeof frame.data === 'string') {
      attachment.emit({ type: 'output', data: frame.data })
      return
    }
    if (type === 'attached') {
      attachment.attachedThisDial = true
      const session = asRecord(frame.session)
      const agentName = typeof session?.agentName === 'string' ? session.agentName : null
      attachment.emit({
        type: 'attached',
        sessionId: typeof frame.sessionId === 'string' ? frame.sessionId : attachment.sessionId,
        // The SERVER's word on what this socket may do, which is the one that
        // governs; the stored scopes are only what we were told at pairing.
        access: frame.scope === 'control' ? 'control' : 'observe',
        title: agentName ?? 'Terminal',
      })
      return
    }
    if (type === 'exit') {
      attachment.emit({ type: 'exit', exitCode: typeof frame.exitCode === 'number' ? frame.exitCode : -1 })
      return
    }
    if (type === 'ended') {
      const reason = typeof frame.reason === 'string' ? frame.reason : 'The session ended on that machine.'
      attachment.emit({ type: 'ended', reason })
      // The session is gone on the other machine; a reconnect would attach to
      // nothing. End the attachment rather than looping.
      finish(attachment, reason)
      return
    }
    if (type === 'error') {
      const text = typeof frame.message === 'string' ? frame.message : 'That machine reported a terminal error.'
      // Remembered only until this dial attaches: an error AFTER the attach (a
      // watch-only socket's refused keystroke) is about one frame, not about
      // the connection, and must not end the pane.
      if (!attachment.attachedThisDial) attachment.refusalThisDial = text
      attachment.emit({
        type: 'error',
        code: typeof frame.code === 'string' ? frame.code : 'error',
        message: text,
      })
    }
  }

  function scheduleRetry(attachment: Attachment, reason: string): void {
    if (attachment.released || attachment.retryTimer) return
    const delayMs = backoffDelayMs(attachment.attempts, { baseMs: RECONNECT_BASE_MS, maxMs: RECONNECT_MAX_MS }) ?? RECONNECT_MAX_MS
    attachment.attempts += 1
    // A sleeping laptop is not an error. Past a few attempts the pane stops
    // promising an imminent reconnection and says plainly that the machine is
    // not answering — while still dialling, so a lid opening just works.
    attachment.emit(
      attachment.attempts > OFFLINE_AFTER_ATTEMPTS
        ? { type: 'status', state: 'offline', detail: reason }
        : { type: 'status', state: 'reconnecting', detail: reason }
    )
    attachment.retryTimer = setTimeout(() => {
      attachment.retryTimer = null
      void dial(attachment)
    }, delayMs)
  }

  /** End an attachment for good and tell the pane why. */
  function finish(attachment: Attachment, reason: string): void {
    if (attachment.released) return
    attachment.released = true
    if (attachment.retryTimer) clearTimeout(attachment.retryTimer)
    attachment.retryTimer = null
    attachment.socket?.close(reason)
    attachment.socket = null
    attachments.delete(attachment.attachId)
    attachment.emit({ type: 'status', state: 'closed', detail: reason })
  }

  function detachTerminal(attachId: unknown): void {
    const attachment = typeof attachId === 'string' ? attachments.get(attachId) : undefined
    if (!attachment) return
    attachment.released = true
    if (attachment.retryTimer) clearTimeout(attachment.retryTimer)
    attachment.retryTimer = null
    attachment.socket?.close('The pane was closed.')
    attachment.socket = null
    attachments.delete(attachment.attachId)
  }

  return {
    listConnections: () => store.list(),
    pair,
    forget(connectionId): FleetConnection[] {
      if (typeof connectionId === 'string') {
        // Panes attached to a machine we just forgot have no credential left to
        // reconnect with; end them rather than leaving them retrying forever.
        for (const attachment of [...attachments.values()]) {
          if (attachment.connectionId === connectionId) finish(attachment, 'This machine was removed from your fleet.')
        }
        store.forget(connectionId)
      }
      return store.list()
    },
    browse,
    listRuns,
    createTerminal,
    attachTerminal,

    sendInput(attachId, data): void {
      const attachment = typeof attachId === 'string' ? attachments.get(attachId) : undefined
      if (!attachment || typeof data !== 'string' || !data) return
      // Dropped while disconnected rather than queued: keystrokes typed at a
      // dead link belong to a screen state that no longer exists, and replaying
      // them into a session on reconnect would run commands nobody re-read.
      attachment.socket?.send({ type: 'input', data })
    },

    resizeTerminal(attachId, cols, rows): void {
      const attachment = typeof attachId === 'string' ? attachments.get(attachId) : undefined
      if (!attachment || !isPositiveInteger(cols) || !isPositiveInteger(rows)) return
      attachment.size = { cols, rows }
      attachment.socket?.send({ type: 'resize', cols, rows })
    },

    detachTerminal,

    shutdown(): void {
      for (const attachment of [...attachments.values()]) detachTerminal(attachment.attachId)
    },
  }
}

function unknownConnectionBrowse(connectionId: unknown): FleetBrowse {
  return {
    connectionId: typeof connectionId === 'string' ? connectionId : '',
    reachable: false,
    unreachableReason: 'That machine is not paired here.',
    unauthorized: false,
    scopes: [],
    terminalAccess: 'none',
    workspaces: [],
    terminals: [],
    gaps: [],
  }
}

function endpointOf(connection: StoredFleetConnection): { host: string; port: number } {
  const parsed = parseTailnetEndpoint(connection.endpoint)
  // Unreadable endpoints never reach the store (the reader drops them), so this
  // is the type system's ask rather than a real branch.
  return parsed ?? { host: connection.endpoint, port: 0 }
}

function defaultDeviceName(): string {
  try {
    return hostname().trim()
  } catch {
    return ''
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
