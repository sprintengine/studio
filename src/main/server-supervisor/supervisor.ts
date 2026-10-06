import { createControlRpc, type ControlRpc } from '../../server/bootstrap/control-rpc'
import {
  serverExitRetryable,
  type ServerBootstrapEnvelope,
  type ServerReady,
  type ServerToSupervisor,
  type SupervisorToServer,
} from '../../server/bootstrap/envelope'

// The shell's side of the Studio server process (phase 6 spec, section 7.1).
// It forks the server, hands it the envelope, waits for `ready`, pings it,
// restarts it with backoff when it crashes or hangs, gives up when it keeps
// failing, and stops it at quit within a budget.
//
//                  ┌──────────── fork ────────────┐
//   IDLE ─start──► STARTING ──ready──► READY       │
//                    │  │                │  exit, crash, or 3 missed pongs (killed first)
//      exit 64–67 ◄──┘  │ exit/timeout   ▼
//      (no retry)       └────────────► BACKOFF 0.5 s · 1 · 2 · 4 · 8 · 10 s ──timer──┘
//          │                              │ 5 crashes in 120 s, or 3 failed boots
//          ▼                              ▼
//        FAILED ◄─────────────────────────┘     retry() → STARTING, counters reset
//
//   STARTING, READY, BACKOFF ──shutdown──► STOPPING ──exit──► STOPPED
//                                            └─budget spent─► kill ─► STOPPED
//
// Only one child lives at a time: nothing is forked until the previous child
// has said `exit`, and a hung child is killed first. Two servers on one data
// directory, even for a moment during a restart, would be two writers.
//
// Electron stays outside: the child is handed in as `fork`, so the whole
// machine runs under a test with a fake child and fake timers.

/** How the child left. */
export type ServerExit = { code: number | null; signal: string | null }

/** What the shell needs of a forked server process. */
export type ServerChild = {
  readonly pid: number | null
  postMessage(message: SupervisorToServer, transfer?: unknown[]): void
  onMessage(listener: (message: unknown) => void): void
  onExit(listener: (exit: ServerExit) => void): void
  /** End it now (SIGKILL on POSIX; TerminateProcess on Windows). */
  kill(): void
}

export type SupervisorState =
  | { kind: 'idle' }
  | { kind: 'starting'; attempt: number }
  | { kind: 'ready'; ready: ServerReady }
  | { kind: 'backoff'; attempt: number; delayMs: number; exit: ServerExit }
  | {
      kind: 'failed'
      reason: string
      exit: ServerExit | null
      /** Never reached ready this session: the boot-time fallback to in process applies (decision O9). */
      neverReady: boolean
    }
  | { kind: 'stopping' }
  | { kind: 'stopped' }

export type ServerHealth = {
  pid: number | null
  /** Restarts this session, not counting the first start. */
  restarts: number
  lastExit: ServerExit | null
  /** The last `fatal` the server sent before it exited, in its own words. */
  lastFatal: string | null
  loopLagMs: number | null
  rssMb: number | null
  startedAt: number | null
}

export type ShutdownProgress = Extract<ServerToSupervisor, { t: 'shutdown-progress' }>

export type ServerSupervisor = {
  readonly state: SupervisorState
  readonly health: ServerHealth
  onState(listener: (state: SupervisorState) => void): () => void
  /** Fork the first server. Called once, at app ready. */
  start(): void
  whenReady(budgetMs: number): Promise<'ready' | 'timeout' | 'failed'>
  /** Requests and events to and from the server, across restarts. */
  readonly rpc: ControlRpc
  call<T>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T>
  /** Send a frame (an attached client's port beside it) to the server now; false when none is running. */
  post(message: SupervisorToServer, transfer?: unknown[]): boolean
  /** Called on every `ready`, the first and each after a restart: the place to attach windows again. */
  onReady(listener: (ready: ServerReady) => void): () => void
  shutdown(options: {
    drain: boolean
    budgetMs: number
    onProgress?: (progress: ShutdownProgress) => void
  }): Promise<'exited' | 'killed'>
  /** Stop the server and start a fresh one (the Diagnostics action, a dev rebuild). */
  restart(reason: string): void
  /** Leave FAILED and try again with the counters reset (the banner's Retry). */
  retry(): void
  /** The machine slept: pings stop counting until a while after it wakes. */
  power(event: 'suspend' | 'resume'): void
}

export type SupervisorTiming = {
  bootBudgetMs: number
  pingIntervalMs: number
  missedPongsToKill: number
  backoffMs: readonly number[]
  /** Time in READY after which the backoff starts over. */
  backoffResetMs: number
  crashWindowMs: number
  crashesInWindow: number
  failedBootsToGiveUp: number
  /** After a wake, how long before a missed pong counts again. */
  resumeGraceMs: number
  /** A quit during STARTING kills the child after this, or the budget, whichever is sooner. */
  startingStopMs: number
  /** How long a restart lets a serving server drain (transcripts flushed, turns ended) before the kill. */
  restartDrainMs: number
  /** After a kill at the budget, how long to wait for the exit before calling the stop done anyway. */
  killExitGraceMs: number
}

export const DEFAULT_SUPERVISOR_TIMING: SupervisorTiming = {
  bootBudgetMs: 15_000,
  pingIntervalMs: 5_000,
  missedPongsToKill: 3,
  backoffMs: [500, 1_000, 2_000, 4_000, 8_000, 10_000],
  backoffResetMs: 60_000,
  crashWindowMs: 120_000,
  crashesInWindow: 5,
  failedBootsToGiveUp: 3,
  resumeGraceMs: 10_000,
  startingStopMs: 2_000,
  restartDrainMs: 5_000,
  killExitGraceMs: 2_000,
}

export type SupervisorDeps = {
  fork: () => ServerChild
  envelope: () => ServerBootstrapEnvelope
  now?: () => number
  log?: (line: string) => void
  timing?: Partial<SupervisorTiming>
}

export function createServerSupervisor(deps: SupervisorDeps): ServerSupervisor {
  const timing = { ...DEFAULT_SUPERVISOR_TIMING, ...deps.timing }
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => undefined)
  const stateListeners = new Set<(state: SupervisorState) => void>()
  const readyListeners = new Set<(ready: ServerReady) => void>()
  const rpc = createControlRpc(null, { log })

  let state: SupervisorState = { kind: 'idle' }
  let child: ServerChild | null = null
  // Set while the child that has exited has not yet said so: the one-child rule.
  let childAlive = false
  let attempt = 0
  let failedBoots = 0
  let everReady = false
  let crashes: number[] = []
  const health: ServerHealth = {
    pid: null,
    restarts: 0,
    lastExit: null,
    lastFatal: null,
    loopLagMs: null,
    rssMb: null,
    startedAt: null,
  }

  let bootTimer: ReturnType<typeof setTimeout> | null = null
  let backoffTimer: ReturnType<typeof setTimeout> | null = null
  let resetTimer: ReturnType<typeof setTimeout> | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null
  let resumeTimer: ReturnType<typeof setTimeout> | null = null
  let stopTimer: ReturnType<typeof setTimeout> | null = null
  let forks = 0
  let pingSeq = 0
  let unansweredPings = 0
  let watchdogPaused = false
  // What happens when the current child exits, decided before it does.
  let onChildExit: ((exit: ServerExit) => void) | null = null
  let restartRequested = false
  let shutdownProgress: ((progress: ShutdownProgress) => void) | null = null
  let shutdownDone: ((outcome: 'exited' | 'killed') => void) | null = null
  let shutdownPromise: Promise<'exited' | 'killed'> | null = null
  let killedForStop = false

  function setState(next: SupervisorState): void {
    state = next
    for (const listener of [...stateListeners]) {
      try {
        listener(next)
      } catch (error) {
        log(`state listener threw: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  function clearTimers(): void {
    for (const timer of [bootTimer, backoffTimer, resetTimer, stopTimer]) if (timer) clearTimeout(timer)
    if (pingTimer) clearInterval(pingTimer)
    bootTimer = backoffTimer = resetTimer = stopTimer = null
    pingTimer = null
    // The wake's grace is the machine's, not this child's: cut short with the
    // child's timers, it would leave the watchdog paused for every later one.
    if (resumeTimer) {
      clearTimeout(resumeTimer)
      resumeTimer = null
      watchdogPaused = false
    }
  }

  function fork(): void {
    if (childAlive) {
      // Never two: the exit handler forks once the previous child is gone.
      log('fork refused: the previous server has not exited yet')
      return
    }
    attempt++
    setState({ kind: 'starting', attempt })
    let next: ServerChild
    try {
      next = deps.fork()
    } catch (error) {
      log(`fork failed: ${error instanceof Error ? error.message : String(error)}`)
      handleExit({ code: null, signal: null }, `The server could not be started: ${errorText(error)}`)
      return
    }
    child = next
    childAlive = true
    forks++
    health.pid = next.pid
    health.startedAt = now()
    health.restarts = forks - 1
    rpc.reopen((frame) => next.postMessage(frame as unknown as SupervisorToServer))
    next.onMessage((message) => {
      if (child !== next) return
      if (rpc.receive(message)) return
      onFrame(message as ServerToSupervisor)
    })
    next.onExit((exit) => {
      if (child !== next) return
      child = null
      childAlive = false
      rpc.close('The Studio server stopped.')
      const decide = onChildExit
      onChildExit = null
      if (decide) decide(exit)
      else handleExit(exit, null)
    })
    next.postMessage({ t: 'envelope', envelope: deps.envelope() })
    bootTimer = setTimeout(() => {
      bootTimer = null
      if (state.kind !== 'starting' || child !== next) return
      log(`the server did not say ready within ${timing.bootBudgetMs} ms; killing it`)
      next.kill()
    }, timing.bootBudgetMs)
  }

  function onFrame(frame: ServerToSupervisor): void {
    switch (frame?.t) {
      case 'ready': {
        if (state.kind !== 'starting') return
        if (bootTimer) clearTimeout(bootTimer)
        bootTimer = null
        everReady = true
        failedBoots = 0
        health.pid = frame.pid
        setState({ kind: 'ready', ready: frame })
        startPings()
        // A server that stays up a while has earned a fresh backoff.
        resetTimer = setTimeout(() => {
          resetTimer = null
          attempt = 0
        }, timing.backoffResetMs)
        for (const listener of [...readyListeners]) {
          try {
            listener(frame)
          } catch (error) {
            log(`ready listener threw: ${errorText(error)}`)
          }
        }
        return
      }
      case 'pong':
        if (frame.seq === pingSeq) unansweredPings = 0
        health.loopLagMs = frame.loopLagMs
        health.rssMb = frame.rssMb
        return
      case 'shutdown-progress':
        shutdownProgress?.(frame)
        return
      case 'fatal':
        health.lastFatal = frame.message
        log(`server fatal ${frame.code}: ${frame.message}`)
        return
      default:
        return
    }
  }

  function startPings(): void {
    if (pingTimer) clearInterval(pingTimer)
    unansweredPings = 0
    pingTimer = setInterval(() => {
      if (state.kind !== 'ready' || !child) return
      if (watchdogPaused) return
      if (unansweredPings >= timing.missedPongsToKill) {
        log(`the server missed ${unansweredPings} pings; killing it (event loop lag ${health.loopLagMs ?? '?'} ms)`)
        if (pingTimer) clearInterval(pingTimer)
        pingTimer = null
        child.kill()
        return
      }
      unansweredPings++
      pingSeq++
      child.postMessage({ t: 'ping', seq: pingSeq })
    }, timing.pingIntervalMs)
  }

  function handleExit(exit: ServerExit, why: string | null): void {
    health.lastExit = exit
    const wasStarting = state.kind === 'starting'
    clearTimers()
    if (restartRequested) {
      restartRequested = false
      attempt = 0
      fork()
      return
    }
    if (exit.code !== null && exit.code !== 0 && !serverExitRetryable(exit)) {
      setState({
        kind: 'failed',
        reason: health.lastFatal ?? why ?? `The Studio server exited with code ${exit.code}.`,
        exit,
        neverReady: !everReady,
      })
      return
    }
    const at = now()
    crashes = [...crashes.filter((when) => at - when < timing.crashWindowMs), at]
    if (wasStarting) failedBoots++
    if (crashes.length >= timing.crashesInWindow || failedBoots >= timing.failedBootsToGiveUp) {
      setState({
        kind: 'failed',
        reason:
          failedBoots >= timing.failedBootsToGiveUp
            ? `The Studio server failed to start ${failedBoots} times.${health.lastFatal ? ` ${health.lastFatal}` : ''}`
            : `The Studio server stopped ${crashes.length} times in two minutes.`,
        exit,
        neverReady: !everReady,
      })
      return
    }
    const delayMs = timing.backoffMs[Math.min(Math.max(attempt - 1, 0), timing.backoffMs.length - 1)]
    setState({ kind: 'backoff', attempt, delayMs, exit })
    backoffTimer = setTimeout(() => {
      backoffTimer = null
      if (state.kind === 'backoff') fork()
    }, delayMs)
  }

  function finishShutdown(outcome: 'exited' | 'killed'): void {
    // Once: a kill whose exit came after the grace has nothing left to finish.
    if (state.kind === 'stopped') return
    clearTimers()
    setState({ kind: 'stopped' })
    const done = shutdownDone
    shutdownDone = null
    shutdownProgress = null
    done?.(outcome)
  }

  const supervisor: ServerSupervisor = {
    get state() {
      return state
    },
    health,
    rpc,
    onState(listener) {
      stateListeners.add(listener)
      return () => {
        stateListeners.delete(listener)
      }
    },
    onReady(listener) {
      readyListeners.add(listener)
      return () => {
        readyListeners.delete(listener)
      }
    },
    start() {
      if (state.kind !== 'idle') return
      fork()
    },
    whenReady(budgetMs) {
      if (state.kind === 'ready') return Promise.resolve('ready')
      if (state.kind === 'failed' || state.kind === 'stopped' || state.kind === 'stopping')
        return Promise.resolve('failed')
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          stop()
          resolve('timeout')
        }, budgetMs)
        const stop = supervisor.onState((next) => {
          if (next.kind === 'ready' || next.kind === 'failed' || next.kind === 'stopping' || next.kind === 'stopped') {
            clearTimeout(timer)
            stop()
            resolve(next.kind === 'ready' ? 'ready' : 'failed')
          }
        })
      })
    },
    call(method, params, options) {
      return rpc.call(method, params, options)
    },
    post(message, transfer) {
      if (!child || state.kind !== 'ready') return false
      try {
        child.postMessage(message, transfer)
        return true
      } catch (error) {
        log(`post to the server failed: ${errorText(error)}`)
        return false
      }
    },
    shutdown(options) {
      if (shutdownPromise) return shutdownPromise
      shutdownPromise = new Promise<'exited' | 'killed'>((resolve) => {
        shutdownDone = resolve
      })
      shutdownProgress = options.onProgress ?? null
      const current = child
      const from = state.kind
      if (backoffTimer) clearTimeout(backoffTimer)
      backoffTimer = null
      if (!current || !childAlive) {
        // BACKOFF, FAILED, IDLE: nothing is running and nothing will be forked.
        finishShutdown('exited')
        return shutdownPromise
      }
      setState({ kind: 'stopping' })
      clearTimers()
      onChildExit = () => finishShutdown(killedForStop ? 'killed' : 'exited')
      // A server still composing has nothing worth a drain and may be stuck;
      // it gets a short while, then the kill. A serving one gets the budget.
      const drain = from === 'ready' && options.drain
      const budget = from === 'ready' ? options.budgetMs : Math.min(timing.startingStopMs, options.budgetMs)
      try {
        current.postMessage({ t: 'shutdown', drain, budgetMs: Math.max(0, budget - 250) })
      } catch {
        // A channel that cannot take the frame: the kill below ends it.
      }
      stopTimer = setTimeout(() => {
        stopTimer = null
        if (!childAlive || child !== current) return
        log(`the server did not stop within ${budget} ms; killing it`)
        killedForStop = true
        current.kill()
        // The kill is the last word: should its exit never be reported, the
        // quit still ends rather than wait on it for ever.
        stopTimer = setTimeout(() => {
          stopTimer = null
          if (shutdownDone) finishShutdown('killed')
        }, timing.killExitGraceMs)
      }, budget)
      return shutdownPromise
    },
    restart(reason) {
      log(`restart: ${reason}`)
      if (state.kind === 'ready' || state.kind === 'starting') {
        if (!child || restartRequested) return
        restartRequested = true
        clearTimers()
        const current = child
        if (state.kind === 'starting') {
          current.kill()
          return
        }
        // A serving server may be mid-turn: it drains first, so its transcripts
        // are flushed and the turn ends as interrupted rather than cut off, and
        // is killed only if the drain overruns. Its exit forks the next one.
        try {
          current.postMessage({ t: 'shutdown', drain: true, budgetMs: Math.max(0, timing.restartDrainMs - 250) })
        } catch {
          current.kill()
          return
        }
        stopTimer = setTimeout(() => {
          stopTimer = null
          if (child !== current || !childAlive) return
          log(`the server did not stop within ${timing.restartDrainMs} ms for its restart; killing it`)
          current.kill()
        }, timing.restartDrainMs)
        return
      }
      if (state.kind === 'backoff' || state.kind === 'failed') supervisor.retry()
    },
    retry() {
      if (state.kind !== 'failed' && state.kind !== 'backoff') return
      clearTimers()
      attempt = 0
      failedBoots = 0
      crashes = []
      fork()
    },
    power(event) {
      if (event === 'suspend') {
        if (resumeTimer) clearTimeout(resumeTimer)
        resumeTimer = null
        watchdogPaused = true
        return
      }
      if (resumeTimer) clearTimeout(resumeTimer)
      resumeTimer = setTimeout(() => {
        resumeTimer = null
        watchdogPaused = false
        unansweredPings = 0
      }, timing.resumeGraceMs)
    },
  }
  return supervisor
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
