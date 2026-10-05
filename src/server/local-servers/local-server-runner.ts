import { execFile, spawn } from 'node:child_process'
import { delimiter } from 'node:path'

import { STUDIO_LOCAL_SERVER_MAX_OUTPUT } from '../../../packages/studio-protocol/src/public'
import { AGENT_IDENTITY_ENV_KEYS, MCP_CHANNEL_TOKEN_ENV, withoutStudioEnv } from '../../shared/studio-env'
import { withoutInheritedSessionEnv } from '../../main/inherited-session-env'
import {
  createLoginShellPathResolver,
  searchDirectories,
  type LoginShellPathDescriptor,
  type LoginShellPathOutcome,
} from '../../main/login-shell-path'
import { killProcessTree } from '../../main/process-tree-kill'

// Running a linked server's command again, as a process the Studio owns: what
// "Run again" does. The command is the agent's, run the way the person's own
// terminal would run it: through their login shell (`$SHELL -lc`, `cmd.exe`
// on Windows), in the folder the agent gave, with the PATH that shell's config
// sets up, so `npm run dev` finds the same `node` it found for the agent. A
// GUI-launched app on macOS inherits almost no PATH of its own, which is why
// the PATH is asked of the person's shell once (login-shell-path.ts) rather
// than taken from this process.
//
// On POSIX the shell is started as the leader of its own process group, so a
// stop reaches what it started too (the `node` under `npm run dev`, a
// watcher's children); on Windows `taskkill /T` walks the tree instead. A run
// has ended when its whole group has, not when the shell has: `serve &` or a
// shell that exits once it has started its server leaves the server running
// in the group, and it is still the Studio's to stop.

/** How often a run whose shell has exited asks whether anything in its group lives. */
const GROUP_POLL_MS = 500

/** A run of a server's command. */
export type LocalServerRun = {
  /** Everything it printed, stdout and stderr together, up to its last `STUDIO_LOCAL_SERVER_MAX_OUTPUT` characters. */
  output(): string
  /** Resolves when the process and everything in its group have ended: the shell's exit code, null when a signal ended it. */
  readonly exited: Promise<{ code: number | null }>
  alive(): boolean
  /** Ask it to stop: SIGTERM to its process group; on Windows the tree is ended outright. */
  terminate(): void
  /** End it and everything it started, now. */
  kill(): void
}

export type StartLocalServerRun = (input: { command: string; cwd: string }) => LocalServerRun

export type LocalServerRunnerOptions = {
  /** The shell a command runs in; the person's login shell unless given. */
  shell?: () => string
  /** The environment a command runs in; this process's, with the login shell's PATH, unless given. */
  env?: () => Promise<Record<string, string>>
  platform?: NodeJS.Platform
}

/** How long a run waits for its last output after it exits, before it is reported. */
const OUTPUT_SETTLE_MS = 250

export function createLocalServerRunner(options: LocalServerRunnerOptions = {}): StartLocalServerRun {
  const platform = options.platform ?? process.platform
  const shell = options.shell ?? (() => process.env.SHELL || '/bin/sh')
  const env = options.env ?? defaultEnv(platform)
  return ({ command, cwd }) => {
    let tail = ''
    const append = (chunk: Buffer | string) => {
      tail = (tail + chunk.toString()).slice(-STUDIO_LOCAL_SERVER_MAX_OUTPUT)
    }
    let child: ReturnType<typeof spawn> | null = null
    let ended = false
    let finish: (exit: { code: number | null }) => void = () => undefined
    const exited = new Promise<{ code: number | null }>((resolve) => {
      finish = (exit) => {
        if (ended) return
        ended = true
        resolve(exit)
      }
    })
    // Asked for before the environment is ready: carried out once it is.
    let pendingSignal: 'terminate' | 'kill' | null = null

    const signal = (kind: 'terminate' | 'kill') => {
      if (ended) return
      if (!child) {
        pendingSignal = kind === 'kill' || pendingSignal === null ? kind : pendingSignal
        return
      }
      const target = child
      if (kind === 'kill' || platform === 'win32') {
        killProcessTree(target, { platform, processGroup: true })
        return
      }
      try {
        if (typeof target.pid === 'number') process.kill(-target.pid, 'SIGTERM')
        else target.kill('SIGTERM')
      } catch {
        // The group is gone already, or never formed: the one process, then.
        try {
          target.kill('SIGTERM')
        } catch {
          // Already gone.
        }
      }
    }

    void env()
      .catch(() => sanitizedProcessEnv())
      .then((environment) => {
        if (ended) return
        if (pendingSignal === 'kill' || pendingSignal === 'terminate') {
          // Stopped before it started: there is nothing to stop.
          finish({ code: null })
          return
        }
        const [file, args] =
          platform === 'win32'
            ? // `/s` strips the outer quotes, so the command is wrapped in a pair
              // of its own: one that starts with a quoted path keeps its quotes.
              [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`]]
            : [shell(), ['-lc', command]]
        const started = spawn(file, args, {
          cwd,
          env: environment,
          detached: platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          ...(platform === 'win32' ? { windowsVerbatimArguments: true } : {}),
        })
        child = started
        started.stdout?.on('data', append)
        started.stderr?.on('data', append)
        started.on('error', (error) => {
          append(`${error.message}\n`)
          finish({ code: null })
        })
        let settle: NodeJS.Timeout | null = null
        started.on('exit', (code) => {
          const done = () => {
            // What it printed last may still be in the pipe: give it a moment,
            // but not for ever (a child it left behind can hold the pipe open).
            settle = setTimeout(() => finish({ code }), OUTPUT_SETTLE_MS)
            started.once('close', () => {
              if (settle) clearTimeout(settle)
              finish({ code })
            })
          }
          const pid = started.pid
          if (platform === 'win32' || typeof pid !== 'number') return done()
          // The shell is gone; what it started may not be.
          const poll = () => {
            if (ended) return
            if (!groupAlive(pid)) return done()
            setTimeout(poll, GROUP_POLL_MS).unref?.()
          }
          poll()
        })
      })

    return {
      output: () => tail,
      exited,
      alive: () => !ended,
      terminate: () => signal('terminate'),
      kill: () => signal('kill'),
    }
  }
}

/** This process's environment, less what belongs to the app itself. */
function sanitizedProcessEnv(): Record<string, string> {
  const env = withoutStudioEnv(
    withoutInheritedSessionEnv(
      Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      ),
    ),
    [...AGENT_IDENTITY_ENV_KEYS, MCP_CHANNEL_TOKEN_ENV],
  )
  // Set inside the desktop for its own helpers; a dev server that is itself
  // an Electron app would start as plain Node with it.
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

function defaultEnv(platform: NodeJS.Platform): () => Promise<Record<string, string>> {
  if (platform === 'win32') return async () => sanitizedProcessEnv()
  const loginPath = createLoginShellPathResolver({ run: runDescriptor, shell: () => process.env.SHELL })
  return async () => {
    const env = sanitizedProcessEnv()
    const path = await loginPath.resolve(env)
    if (path) env.PATH = searchDirectories(path, env.PATH).join(delimiter)
    return env
  }
}

function runDescriptor(descriptor: LoginShellPathDescriptor, env: NodeJS.ProcessEnv): Promise<LoginShellPathOutcome> {
  return new Promise((resolve) => {
    execFile(
      descriptor.file,
      descriptor.args,
      { env, timeout: descriptor.timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        const failure = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null
        resolve({
          code: typeof failure?.code === 'number' ? failure.code : failure ? 1 : 0,
          stdout: String(stdout ?? ''),
          timedOut: failure?.killed === true,
        })
      },
    )
  })
}

/** Whether anything in the process group `pgid` leads is still running. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    // EPERM: a member lives but is not ours to signal, which still means alive.
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}
