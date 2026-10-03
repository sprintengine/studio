import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

import { ServerBootstrapError, readEnvelope, type ServerControlChannel } from './control-channel'
import { createControlRpc, type ControlRpc } from './control-rpc'
import {
  SERVER_EXIT,
  type FrontDoorReady,
  type ServerBootstrapEnvelope,
  type ServerExitCode,
  type ServerReady,
  type ServerToSupervisor,
  type SupervisorToServer,
} from './envelope'

// A server's life on a control channel, whichever carrier it is: read the
// envelope, start, say `ready`, answer pings, and stop when told to or when the
// channel goes (phase 6 spec, section 7.2):
//
//   BOOTING ──envelope ok──► STARTING (lock, compose, listen) ──► SERVING
//      │ bad envelope (64)        │ start refused (65, 66, 67, 70, 75)   │ shutdown
//      ▼                          ▼                                      ▼
//    EXIT                       EXIT                       DRAINING ──► EXIT 0
//
// A `shutdown` that arrives while the server is still starting is kept and
// carried out once it has started (or has failed to). The supervisor's own
// budget is the backstop: a server that does not leave in time is killed.

export type ServerAttach = Extract<SupervisorToServer, { t: 'attach-client' }>

/** What a role's start hands back. */
export type RunningServer = {
  environmentId: string
  gatewaySocket: string | null
  tailnetBound: string | null
  /** A WSL server's front door, said in `ready`. */
  frontDoor?: FrontDoorReady
  /**
   * Stop, leg by leg, saying each one as it finishes. `drain: false` is a
   * quit during boot or a lost parent: only what cannot be lost runs.
   */
  stop(options: { drain: boolean; onLeg: (progress: ShutdownLegProgress) => void }): Promise<void>
  /** A client's port arrived (desktop-local only). */
  attachClient?(attach: ServerAttach, port: unknown): void
  detachClient?(clientId: string): void
}

export type ShutdownLegProgress = { leg: string; done: number; total: number; failed: boolean; durationMs: number }

export type ServerStart = (input: {
  envelope: ServerBootstrapEnvelope
  rpc: ControlRpc
  channel: ServerControlChannel
  log: (message: string) => void
  /**
   * The server has to go of its own accord (its data directory was taken
   * over): it stops as for a shutdown and exits with `code`.
   */
  requestExit: (code: ServerExitCode, reason: string) => void
}) => Promise<RunningServer>

/** A start failure that names its exit code (the core's data directory errors, a refused envelope). */
type ExitCoded = Error & { exitCode: number }

export type ServeOptions = {
  /** The start for each role this bundle can be. A role with none is refused (64). */
  starters: Partial<Record<ServerBootstrapEnvelope['role'], ServerStart>>
  /** Whether the envelope arrives bare (stdio) or as `{ t: 'envelope' }` (a parent port). */
  unwrapEnvelope: boolean
  /** This bundle's build stamp; checked against the envelope's when both are known (67 on a mismatch). */
  buildStamp: string | null
  log: (message: string) => void
  /** The envelope arrived and was read, before anything starts from it (where a WSL server's log goes). */
  onEnvelope?: (envelope: ServerBootstrapEnvelope) => void
  envelopeTimeoutMs?: number
  /** The longest a stop asked for without a budget may take. */
  defaultStopBudgetMs?: number
}

export type ServerState = 'booting' | 'starting' | 'serving' | 'draining' | 'exited'

const DEFAULT_STOP_BUDGET_MS = 8_000
/** How long a detached server's turns get to finish when it is asked to stop (an upgrade, `studio-server stop`). */
export const DETACHED_STOP_BUDGET_MS = 60_000

/**
 * Serve on `channel` until the server should exit; resolves to the exit code.
 * The caller exits the process with it: a parent port keeps the event loop
 * alive, so a server never leaves by running out of work.
 */
export async function serveOnChannel(channel: ServerControlChannel, options: ServeOptions): Promise<number> {
  const send = (frame: ServerToSupervisor): void => channel.send(frame)
  const fatal = (code: ServerExitCode | number, message: string): number => {
    options.log(message)
    send({ t: 'fatal', code: code as ServerExitCode, message })
    return code
  }

  let envelope: ServerBootstrapEnvelope
  try {
    ;({ envelope } = await readEnvelope(channel, {
      unwrap: options.unwrapEnvelope,
      ...(options.envelopeTimeoutMs ? { timeoutMs: options.envelopeTimeoutMs } : {}),
    }))
  } catch (error) {
    return fatal(SERVER_EXIT.usage, error instanceof ServerBootstrapError ? error.message : String(error))
  }
  options.onEnvelope?.(envelope)

  const start = options.starters[envelope.role]
  if (!start) return fatal(SERVER_EXIT.usage, `This server cannot run as ${envelope.role}.`)
  if (options.buildStamp && envelope.app.buildStamp && options.buildStamp !== envelope.app.buildStamp) {
    return fatal(
      SERVER_EXIT.mismatch,
      `[build-skew] The shell was built from ${envelope.app.buildStamp.slice(0, 7)} and this server from ` +
        `${options.buildStamp.slice(0, 7)}. Rebuild so both come from one commit.`,
    )
  }

  let state: ServerState = 'starting'
  const rpc = createControlRpc((frame) => channel.send(frame), { log: options.log })
  const loopDelay = monitorEventLoopDelay({ resolution: 20 })
  loopDelay.enable()

  let running: RunningServer | null = null
  // Set when the server asks to leave on its own; the exit says why.
  let exitCode: number | null = null
  let stopRequest: { drain: boolean; budgetMs: number } | null = null
  const pendingAttaches: Array<[ServerAttach, unknown]> = []
  let settle: (code: number) => void = () => undefined
  const exited = new Promise<number>((resolve) => {
    settle = resolve
  })

  const stop = (request: { drain: boolean; budgetMs: number }): void => {
    stopRequest ??= request
    // Carried out once the start has settled; a second request changes nothing.
    if (!running || state !== 'serving') return
    state = 'draining'
    const server = running
    const budget = setTimeout(() => {
      options.log(`stop took longer than ${request.budgetMs} ms; leaving anyway`)
      finish(SERVER_EXIT.ok)
    }, request.budgetMs)
    void server
      .stop({
        drain: request.drain,
        onLeg: (progress) => send({ t: 'shutdown-progress', ...progress }),
      })
      .then(
        () => finish(SERVER_EXIT.ok),
        (error: unknown) => {
          options.log(`stop failed: ${error instanceof Error ? error.message : String(error)}`)
          finish(SERVER_EXIT.ok)
        },
      )
      .finally(() => clearTimeout(budget))
  }
  const finish = (code: number): void => {
    if (state === 'exited') return
    state = 'exited'
    loopDelay.disable()
    rpc.close('The Studio server has stopped.')
    settle(exitCode ?? code)
  }
  const requestExit = (code: ServerExitCode, reason: string): void => {
    exitCode ??= code
    options.log(reason)
    stop({ drain: true, budgetMs: options.defaultStopBudgetMs ?? DEFAULT_STOP_BUDGET_MS })
  }

  channel.onMessage((message, ports) => {
    if (rpc.receive(message)) return
    const frame = message as Partial<SupervisorToServer> | null
    switch (frame?.t) {
      case 'ping': {
        const lag = loopDelay.percentile(99) / 1e6
        loopDelay.reset()
        send({
          t: 'pong',
          seq: typeof frame.seq === 'number' ? frame.seq : 0,
          loopLagMs: Math.round(Number.isFinite(lag) ? lag : 0),
          rssMb: Math.round(process.memoryUsage.rss() / (1024 * 1024)),
        })
        return
      }
      case 'shutdown':
        stop({
          drain: frame.drain !== false,
          budgetMs:
            typeof frame.budgetMs === 'number'
              ? frame.budgetMs
              : (options.defaultStopBudgetMs ?? DEFAULT_STOP_BUDGET_MS),
        })
        return
      case 'attach-client': {
        const attach = frame as ServerAttach
        if (running) running.attachClient?.(attach, ports[0])
        else pendingAttaches.push([attach, ports[0]])
        return
      }
      case 'detach-client':
        if (typeof frame.clientId === 'string') running?.detachClient?.(frame.clientId)
        return
      default:
        return
    }
  })
  if (envelope.detached) {
    // A detached server's starter leaves once it has said `ready`; that is
    // not the end of the server, which runs on until a signal or its idle
    // rule stops it. A signal drains: the turns a person left running get
    // the drain budget to finish or suspend (phase 8 spec, 5.6).
    channel.onClose(() => options.log('The starter has gone; this server runs on, detached.'))
    // A hangup is the session it was started from ending, which it outlives.
    process.on('SIGHUP', () => options.log('The session that started this server ended; it runs on.'))
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.on(signal, () => {
        if (state === 'draining' || state === 'exited') return
        options.log(`Asked to stop (${signal}).`)
        stop({ drain: true, budgetMs: DETACHED_STOP_BUDGET_MS })
      })
    }
  } else {
    // The parent is gone (stdin ended): nothing can be shown, so the stop does
    // only what cannot be lost, and does not wait long.
    channel.onClose(() => stop({ drain: false, budgetMs: options.defaultStopBudgetMs ?? DEFAULT_STOP_BUDGET_MS }))
  }

  const startedAt = performance.now()
  try {
    running = await start({ envelope, rpc, channel, log: options.log, requestExit })
  } catch (error) {
    loopDelay.disable()
    rpc.close('The Studio server did not start.')
    const code = isExitCoded(error) ? error.exitCode : SERVER_EXIT.failed
    return fatal(code, error instanceof Error ? error.message : String(error))
  }
  state = 'serving'
  for (const [attach, port] of pendingAttaches.splice(0)) running.attachClient?.(attach, port)
  const ready: ServerReady = {
    t: 'ready',
    pid: process.pid,
    environmentId: running.environmentId,
    version: envelope.app.version,
    buildStamp: options.buildStamp ?? envelope.app.buildStamp,
    gateway: { socketPath: running.gatewaySocket },
    tailnet: { bound: running.tailnetBound },
    bootMs: Math.round(performance.now() - startedAt),
    ...(running.frontDoor ? { frontDoor: running.frontDoor } : {}),
  }
  send(ready)
  options.log(`ready in ${ready.bootMs} ms: gateway ${ready.gateway.socketPath ?? 'not running'}`)
  const asked = stopRequest as { drain: boolean; budgetMs: number } | null
  if (asked) {
    stopRequest = null
    stop(asked)
  }
  return exited
}

function isExitCoded(error: unknown): error is ExitCoded {
  return error instanceof Error && typeof (error as Partial<ExitCoded>).exitCode === 'number'
}

/**
 * Run a stop's legs in order, each best-effort, saying each one as it ends.
 * A leg that throws is reported failed and the next one runs: the process is
 * leaving either way, and a later leg (the lock) must not be skipped.
 */
export async function runShutdownLegs(
  legs: ReadonlyArray<readonly [string, () => unknown]>,
  onLeg?: (progress: ShutdownLegProgress) => void,
): Promise<void> {
  let done = 0
  for (const [leg, run] of legs) {
    const started = performance.now()
    let failed = false
    try {
      await run()
    } catch {
      failed = true
    }
    done++
    onLeg?.({ leg, done, total: legs.length, failed, durationMs: Math.round(performance.now() - started) })
  }
}
