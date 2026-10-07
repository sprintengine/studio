import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import type {
  StudioLocalServer,
  StudioLocalServerOwner,
  StudioLocalServerState,
  StudioLocalServersMethodMap,
  StudioLocalServersTarget,
} from '../../../packages/studio-protocol/src/public'
import { createTcpProbe, type LocalServerProbe } from './local-server-probe'
import {
  createLocalServerRecord,
  readLocalServerUrl,
  type LinkedLocalServer,
  type LocalServerConversationKey,
  type LocalServerLinkInput,
  type LocalServerRecord,
} from './local-server-record'
import { createLocalServerRunner, type LocalServerRun, type StartLocalServerRun } from './local-server-runner'

// The local servers a conversation's agent started, as a server domain (owner
// ruling 2026-10-04), shaped like the pull request record beside it: the
// gateway's `local_server.link` is how an agent says "I started this", the
// record keeps the link, and every client reads `localServers.*` and draws
// what it is told.
//
// LIVENESS IS CHECKED HERE, where the agents run, by a TCP connect to the
// server's port (local-server-probe.ts). A server that is up, starting, or
// changed or was linked in the last `RECENT_MS` is checked every `ACTIVE_MS`;
// the rest, quiet for a while, every `IDLE_MS`. At most `MAX_CONCURRENT_PROBES`
// connects are in flight at once. A state is never written down: at start
// every link is unknown and is checked at once, and `list` waits for that
// first check, so a client never draws "Stopped" for a server that is up.
//
// A change is published only when something a client draws moved (a state, a
// link added, changed, moved or removed, a run starting or ending), never for
// a check that found what the last one did.
//
// RUN AGAIN starts the link's command as a process the Studio owns
// (local-server-runner.ts). It reads as `starting` until its port opens,
// checked every `STARTING_MS` for up to `STARTING_LIMIT_MS`; after that the
// ordinary check decides. Only that run can be stopped from a client: a
// server the agent started belongs to the agent's process. When the run ends,
// how it ended (`lastExit`) is kept until the next run starts.

/** How long a change or a link keeps a server on the quick cadence. */
export const RECENT_MS = 10 * 60_000
/** How often a running, starting or recently changed server is checked. */
export const ACTIVE_MS = 5_000
/** How often a server quiet for a while is checked. */
export const IDLE_MS = 30_000
/** How often a run that has not opened its port yet is checked. */
export const STARTING_MS = 1_000
/** How long a run may take to open its port before the ordinary check decides. */
export const STARTING_LIMIT_MS = 120_000
/** How long a stopped run has to end after SIGTERM before it is killed. */
export const STOP_GRACE_MS = 5_000
/** How long the domain's end waits for its runs after SIGTERM before it kills them. */
export const DISPOSE_GRACE_MS = 1_500
/** The longest a list waits for the first check of a record loaded from disk. */
export const FIRST_CHECK_WAIT_MS = 5_000
/** The most connects in flight at once. */
export const MAX_CONCURRENT_PROBES = 8

export type LocalServersChanged = { workspaceIds: string[]; conversations: StudioLocalServerOwner[] }

/** Why a request was refused, in the protocol's codes. */
export type LocalServerRefusal = { ok: false; code: 'invalid_params' | 'conflict' | 'not_found'; message: string }

/** What the protocol serves; `StudioRpc` takes this. */
export type StudioLocalServers = {
  list(target: StudioLocalServersTarget): Promise<StudioLocalServersMethodMap['localServers.list']['result']>
  run(input: StudioLocalServersMethodMap['localServers.run']['params']): Promise<{ ok: true } | LocalServerRefusal>
  stop(
    input: StudioLocalServersMethodMap['localServers.stop']['params'],
  ): Promise<{ ok: true; stopped: boolean } | LocalServerRefusal>
  remove(input: StudioLocalServersMethodMap['localServers.remove']['params']): Promise<{ removed: boolean }>
  onChanged(listener: (change: LocalServersChanged) => void): () => void
}

/** What linking came to, as the gateway's tool reports it. */
export type LocalServerLinkOutcome =
  { ok: true; server: StudioLocalServer; created: boolean } | { ok: false; code: 'invalid_arguments'; message: string }

export type LocalServerDomain = StudioLocalServers & {
  readonly record: LocalServerRecord
  /** An agent says it started this server: the gateway's `local_server.link`. Checked once before it answers. */
  linkForAgent(key: LocalServerConversationKey, input: LocalServerLinkInput): Promise<LocalServerLinkOutcome>
  /**
   * Workspaces may have been removed: forget their links, stopping any run of
   * theirs first, so a removed workspace's servers are not checked for ever.
   */
  prune(): Promise<void>
  /** Settle what is in flight: a quit's leg. */
  flush(): Promise<void>
  /**
   * Stop every run the Studio started, and every timer. A run is a process
   * this app owns: left alone at quit it would hold its port with no app to
   * stop it from.
   */
  dispose(): Promise<void>
}

export type LocalServerDomainOptions = {
  dataDir: string
  /** The folder a conversation works in: where a command an agent gave without one runs. */
  conversationFolder(key: LocalServerConversationKey): string | null
  /** Whether a workspace was removed; its links go with it (`prune`). */
  workspaceRemoved?(workspaceId: string): boolean
  /** The record, built here unless given (tests). */
  record?: LocalServerRecord
  probe?: LocalServerProbe
  startRun?: StartLocalServerRun
  now?: () => number
  /** The cadences above, shortened by tests. */
  timing?: Partial<{
    activeMs: number
    idleMs: number
    recentMs: number
    startingMs: number
    startingLimitMs: number
    stopGraceMs: number
    disposeGraceMs: number
    firstCheckWaitMs: number
  }>
  log?(message: string, error?: unknown): void
}

type Live = {
  /** Null until the first check. */
  state: StudioLocalServerState | null
  stateAt: number
  /** When `state` last became what it is. */
  changedAt: number
  dueAt: number
  probing: boolean
}

type OwnRun = {
  run: LocalServerRun
  startedAt: number
  stopping: Promise<boolean> | null
  /** Its port has opened once: from then on a closed port reads as stopped, not as starting again. */
  opened: boolean
}

export function createLocalServerDomain(options: LocalServerDomainOptions): LocalServerDomain {
  const now = options.now ?? (() => Date.now())
  const timing = {
    activeMs: ACTIVE_MS,
    idleMs: IDLE_MS,
    recentMs: RECENT_MS,
    startingMs: STARTING_MS,
    startingLimitMs: STARTING_LIMIT_MS,
    stopGraceMs: STOP_GRACE_MS,
    disposeGraceMs: DISPOSE_GRACE_MS,
    firstCheckWaitMs: FIRST_CHECK_WAIT_MS,
    ...options.timing,
  }
  const log =
    options.log ??
    ((message: string, error?: unknown) => {
      console.warn(`[local-servers] ${message}`, error ?? '')
    })
  const probe = options.probe ?? createTcpProbe()
  const startRun = options.startRun ?? createLocalServerRunner()
  const record =
    options.record ?? createLocalServerRecord({ dataDir: options.dataDir, now, log, keep: (id) => runs.has(id) })
  const listeners = new Set<(change: LocalServersChanged) => void>()
  const live = new Map<string, Live>()
  const runs = new Map<string, OwnRun>()
  const lastExits = new Map<string, NonNullable<StudioLocalServer['lastExit']>>()
  let disposed = false
  /** A list was answered before the first check finished, so a link it drew as stopped may be up. */
  let answeredUnchecked = false
  let timer: NodeJS.Timeout | null = null
  let round: Promise<void> | null = null

  // ── Publishing ────────────────────────────────────────────────────────────

  function publish(entries: Array<{ workspaceId: string; agentId: string }>): void {
    if (disposed || entries.length === 0) return
    const workspaceIds = [...new Set(entries.map((entry) => entry.workspaceId))]
    const seen = new Set<string>()
    const conversations: StudioLocalServerOwner[] = []
    for (const entry of entries) {
      const id = `${entry.workspaceId}\0${entry.agentId}`
      if (seen.has(id)) continue
      seen.add(id)
      conversations.push({ workspaceId: entry.workspaceId, agentId: entry.agentId })
    }
    const change = { workspaceIds, conversations }
    for (const listener of [...listeners]) {
      try {
        listener(change)
      } catch (error) {
        log('a local server listener failed', error)
      }
    }
  }

  // ── Checking ──────────────────────────────────────────────────────────────

  function liveOf(id: string): Live {
    let entry = live.get(id)
    if (!entry) {
      entry = { state: null, stateAt: 0, changedAt: 0, dueAt: 0, probing: false }
      live.set(id, entry)
    }
    return entry
  }

  function isStarting(id: string): boolean {
    const own = runs.get(id)
    return own !== undefined && own.stopping === null && !own.opened && now() - own.startedAt < timing.startingLimitMs
  }

  function cadenceOf(server: LinkedLocalServer, entry: Live): number {
    if (entry.state === 'starting') return timing.startingMs
    const at = now()
    if (entry.state === 'running' || at - entry.changedAt < timing.recentMs || at - server.linkedAt < timing.recentMs)
      return timing.activeMs
    return timing.idleMs
  }

  /** Check one server and set its state; whether what a client draws changed. */
  async function check(server: LinkedLocalServer): Promise<boolean> {
    const entry = liveOf(server.id)
    entry.probing = true
    let open = false
    try {
      open = await probe(server.host, server.port)
    } catch {
      open = false
    } finally {
      entry.probing = false
    }
    if (disposed || !record.get(server.id)) return false
    const own = runs.get(server.id)
    if (open && own) own.opened = true
    const next: StudioLocalServerState = open ? 'running' : isStarting(server.id) ? 'starting' : 'stopped'
    const at = now()
    const previous = entry.state
    entry.stateAt = at
    if (previous !== next) {
      entry.state = next
      // A first check is not a change: a link read from disk keeps its own
      // cadence rather than ten quick minutes after every start.
      if (previous !== null) entry.changedAt = at
    }
    entry.dueAt = at + cadenceOf(server, entry)
    // The first check of a link loaded from disk is what `list` waited for:
    // nobody has drawn anything for it yet, unless a list stopped waiting and
    // drew it as stopped.
    if (previous === null) return answeredUnchecked && next !== 'stopped'
    return previous !== next
  }

  /** Check every server that is due, `MAX_CONCURRENT_PROBES` at a time, and publish what moved. */
  function checkDue(force = false): Promise<void> {
    if (round) return round
    round = (async () => {
      const at = now()
      const due = record.all().filter((server) => {
        const entry = liveOf(server.id)
        return !entry.probing && (force || entry.dueAt <= at)
      })
      const moved: LinkedLocalServer[] = []
      let next = 0
      const worker = async () => {
        while (next < due.length && !disposed) {
          const server = due[next++]!
          if (await check(server)) moved.push(server)
        }
      }
      await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_PROBES, due.length) }, worker))
      publish(moved)
    })()
      .catch((error) => log('could not check the local servers', error))
      .finally(() => {
        round = null
        schedule()
      })
    return round
  }

  function schedule(): void {
    if (disposed) return
    if (timer) clearTimeout(timer)
    timer = null
    let soonest = Number.POSITIVE_INFINITY
    // A server being checked right now is not due: its check sets when it
    // next is, and counting its past due time would wake a round per tick
    // with nothing to do until the connect settles.
    for (const server of record.all()) {
      const entry = liveOf(server.id)
      if (!entry.probing) soonest = Math.min(soonest, entry.dueAt)
    }
    if (!Number.isFinite(soonest)) return
    timer = setTimeout(
      () => {
        timer = null
        void checkDue()
      },
      Math.max(0, soonest - now()),
    )
    timer.unref?.()
  }

  // At start: read the record, forget what a workspace removed while the
  // Studio was not running left behind, then check everything on it once.
  // `list` waits for both.
  let readySettled = false
  const ready: Promise<void> = record
    .whenLoaded()
    .then(() => prune())
    .then(() => checkDue(true))
    .catch((error) => log('could not start the local server checks', error))
    .finally(() => {
      readySettled = true
    })

  /**
   * The record read, and its first check given `firstCheckWaitMs`: what an
   * action waits for. An action needs the links, not every state; a record of
   * hosts that do not answer must not hold an agent's link or a click.
   */
  async function settled(): Promise<void> {
    await record.whenLoaded()
    await waitAtMost(ready, timing.firstCheckWaitMs)
  }

  // ── Wire ──────────────────────────────────────────────────────────────────

  function toWire(server: LinkedLocalServer): StudioLocalServer {
    const entry = live.get(server.id)
    const lastExit = lastExits.get(server.id)
    return {
      id: server.id,
      agentId: server.agentId,
      url: server.url,
      title: server.title || hostAndPort(server),
      port: server.port,
      state: entry?.state ?? 'stopped',
      linkedAt: server.linkedAt,
      stateAt: entry?.stateAt ?? 0,
      ...(server.command ? { command: server.command } : {}),
      ...(server.cwd ? { cwd: server.cwd } : {}),
      ...(runs.has(server.id) ? { startedByStudio: true as const } : {}),
      ...(lastExit ? { lastExit: { ...lastExit } } : {}),
    }
  }

  function owned(conversation: StudioLocalServerOwner, id: string): LinkedLocalServer | null {
    const server = record.get(id)
    return server && server.workspaceId === conversation.workspaceId && server.agentId === conversation.agentId
      ? server
      : null
  }

  const notFound = (): LocalServerRefusal => ({
    ok: false,
    code: 'not_found',
    message: 'That conversation has no local server with that id.',
  })

  // ── Runs ──────────────────────────────────────────────────────────────────

  function followRun(id: string, own: OwnRun): void {
    void own.run.exited.then(async ({ code }) => {
      if (runs.get(id) !== own) return
      runs.delete(id)
      const server = record.get(id)
      // Removed while it ran, or the domain is ending: nobody draws it any more.
      if (disposed || !server) return
      // A run the person stopped ended because they asked; there is nothing
      // to explain. One that ended on its own says how.
      const exit = own.stopping === null ? { code, at: now(), output: own.run.output() } : null
      // The run is over; what is on the port now is read fresh. The exit is
      // kept only once that read is in, so nobody sees how a run ended beside
      // a state that still says it is starting.
      await check(server)
      // Run again started while the port was read: that run owns the line now.
      if (exit && !runs.has(id) && record.get(id)) lastExits.set(id, exit)
      publish([server])
      schedule()
    })
  }

  /** Stop the Studio's run of a server: SIGTERM, then a kill after `grace`. Whether it ended. */
  function stopRun(id: string, grace: number): Promise<boolean> {
    const own = runs.get(id)
    if (!own) return Promise.resolve(false)
    own.stopping ??= (async () => {
      own.run.terminate()
      let killer: NodeJS.Timeout | null = null
      const graceOver = new Promise<'grace'>((resolve) => {
        killer = setTimeout(() => resolve('grace'), grace)
      })
      const first = await Promise.race([own.run.exited.then(() => 'exited' as const), graceOver])
      if (killer) clearTimeout(killer)
      if (first === 'grace') {
        own.run.kill()
        // A kill is not refused; give the group a moment to go.
        await Promise.race([own.run.exited, new Promise((resolve) => setTimeout(resolve, 1_000))])
      }
      const ended = !own.run.alive()
      // One that outlived it all may be asked again: the next stop signals anew.
      if (!ended) own.stopping = null
      return ended
    })()
    return own.stopping
  }

  async function run(
    input: StudioLocalServersMethodMap['localServers.run']['params'],
  ): Promise<{ ok: true } | LocalServerRefusal> {
    await settled()
    const server = owned(input.conversation, input.id)
    if (!server) return notFound()
    if (!server.command)
      return {
        ok: false,
        code: 'invalid_params',
        message: 'The agent did not say how to start this server, so it cannot be run again.',
      }
    // Asked again rather than trusted: the last check may be half a minute old.
    const busy = runs.has(server.id) || (await probe(server.host, server.port).catch(() => false))
    if (busy) return { ok: false, code: 'conflict', message: 'This server is already running.' }
    const cwd = server.cwd ?? options.conversationFolder(input.conversation)
    if (!cwd || !isAbsolute(cwd) || !(await isDirectory(cwd)))
      return {
        ok: false,
        code: 'invalid_params',
        message: cwd ? `The folder this server runs in is gone: ${cwd}` : 'There is no folder to run this server in.',
      }
    if (disposed || runs.has(server.id))
      return { ok: false, code: 'conflict', message: 'This server is already running.' }
    // Removed, or taken over by another conversation, while its port and
    // folder were checked: a run started now would follow no link, with
    // nothing on screen to stop it.
    if (!owned(input.conversation, server.id)) return notFound()
    const own: OwnRun = {
      run: startRun({ command: server.command, cwd }),
      startedAt: now(),
      stopping: null,
      opened: false,
    }
    runs.set(server.id, own)
    lastExits.delete(server.id)
    const entry = liveOf(server.id)
    entry.state = 'starting'
    entry.changedAt = now()
    entry.stateAt = now()
    entry.dueAt = now() + timing.startingMs
    followRun(server.id, own)
    publish([server])
    schedule()
    return { ok: true }
  }

  // ── Removed workspaces ────────────────────────────────────────────────────

  async function prune(): Promise<void> {
    if (disposed || !options.workspaceRemoved) return
    const removed = [...new Set(record.all().map((server) => server.workspaceId))].filter((workspaceId) =>
      options.workspaceRemoved!(workspaceId),
    )
    const stopping: Array<Promise<boolean>> = []
    const gone: LinkedLocalServer[] = []
    for (const workspaceId of removed) {
      // A run is stopped before its link goes: the record never pushes out a
      // link a run follows, and nothing would be left on screen to stop it.
      for (const server of record.forWorkspace(workspaceId))
        if (runs.has(server.id)) stopping.push(stopRun(server.id, timing.stopGraceMs))
      for (const server of record.forgetWorkspace(workspaceId)) {
        live.delete(server.id)
        lastExits.delete(server.id)
        gone.push(server)
      }
    }
    if (gone.length === 0) return
    publish(gone)
    schedule()
    await Promise.allSettled(stopping)
  }

  // ── Linking ───────────────────────────────────────────────────────────────

  async function linkForAgent(
    key: LocalServerConversationKey,
    input: LocalServerLinkInput,
  ): Promise<LocalServerLinkOutcome> {
    const address = readLocalServerUrl(input.url)
    if (!address) return { ok: false, code: 'invalid_arguments', message: '"url" is an http or https URL with a host.' }
    await settled()
    const cwd = input.cwd ?? (input.command ? (options.conversationFolder(key) ?? undefined) : undefined)
    const linked = record.link(key, {
      url: input.url,
      ...(input.title ? { title: input.title } : {}),
      ...(input.command ? { command: input.command } : {}),
      ...(cwd ? { cwd } : {}),
    })
    for (const dropped of linked.dropped) {
      live.delete(dropped.id)
      lastExits.delete(dropped.id)
      void stopRun(dropped.id, timing.stopGraceMs)
    }
    // Checked before answering, so the agent and the first list both see the
    // truth; the quick cadence follows from the fresh link.
    const server = linked.server
    const entry = liveOf(server.id)
    if (!isStarting(server.id)) {
      const open = await probe(server.host, server.port).catch(() => false)
      if (disposed) return { ok: true, server: toWire(server), created: linked.created }
      const next: StudioLocalServerState = open ? 'running' : 'stopped'
      if (entry.state !== next) entry.changedAt = now()
      entry.state = next
      entry.stateAt = now()
    }
    entry.dueAt = now() + cadenceOf(server, entry)
    publish([server, ...(linked.movedFrom ? [linked.movedFrom] : []), ...linked.dropped])
    schedule()
    return { ok: true, server: toWire(server), created: linked.created }
  }

  return {
    record,
    linkForAgent,
    async list(target) {
      // A list asked for before the record is read and checked would be empty,
      // or say "Stopped" for a server that is up: wait for both. Not for ever:
      // a long record of links to hosts that do not answer takes a while to
      // check, and a client is better told something; it hears what the
      // check finds after (`answeredUnchecked`).
      await waitAtMost(ready, timing.firstCheckWaitMs)
      if (!readySettled) answeredUnchecked = true
      const workspaces: Record<string, StudioLocalServer[]> = {}
      for (const workspaceId of target.workspaceIds ?? []) {
        const found = record.forWorkspace(workspaceId)
        if (found.length > 0) workspaces[workspaceId] = found.map(toWire)
      }
      const conversations: Array<StudioLocalServerOwner & { servers: StudioLocalServer[] }> = []
      for (const key of target.conversations ?? []) {
        const found = record.forConversation(key)
        if (found.length > 0) conversations.push({ ...key, servers: found.map(toWire) })
      }
      return { workspaces, conversations }
    },
    run,
    prune,
    async stop(input) {
      await settled()
      const server = owned(input.conversation, input.id)
      if (!server) return notFound()
      if (!runs.has(server.id))
        return {
          ok: false,
          code: 'conflict',
          message: 'Studio did not start this run of the server; the agent that started it can stop it.',
        }
      return { ok: true, stopped: await stopRun(server.id, timing.stopGraceMs) }
    },
    async remove(input) {
      await settled()
      const server = owned(input.conversation, input.id)
      if (!server) return { removed: false }
      record.remove(server.id)
      live.delete(server.id)
      lastExits.delete(server.id)
      publish([server])
      if (runs.has(server.id)) await stopRun(server.id, timing.stopGraceMs)
      schedule()
      return { removed: true }
    },
    onChanged(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async flush() {
      // Not the checks: a quit has no use for a state nobody will draw, and
      // a round of connects to hosts that do not answer would hold it up.
      await record.whenLoaded()
      await record.flush()
    },
    async dispose() {
      if (disposed) return
      disposed = true
      if (timer) clearTimeout(timer)
      timer = null
      listeners.clear()
      await Promise.allSettled([...runs.keys()].map((id) => stopRun(id, timing.disposeGraceMs)))
      runs.clear()
      // A link or removal made on the way out is written down.
      await record.flush().catch(() => undefined)
      record.dispose()
    },
  }
}

function hostAndPort(server: LinkedLocalServer): string {
  try {
    return new URL(server.url).host
  } catch {
    return `${server.host}:${server.port}`
  }
}

/** `promise`, or `ms` going by, whichever is first. */
async function waitAtMost(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | null = null
  try {
    await Promise.race([promise, new Promise((resolve) => (timer = setTimeout(resolve, ms)))])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
