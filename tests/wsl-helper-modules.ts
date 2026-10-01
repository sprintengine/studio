// Typed handles on the WSL helper's own modules, for the tests that exercise
// them. The helper is plain Node that ships as `.mjs` under resources/ and
// runs inside Linux, so the tests load it by path rather than through the
// TypeScript build.

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const HELPER_DIR = join(process.cwd(), 'resources', 'wsl-helper')
export const HELPER_ENTRY = join(HELPER_DIR, 'helper.mjs')

export type FramesModule = {
  PROTOCOL_VERSION: number
  createLineDecoder(options: { maxLineBytes: number; onLine(line: string): void; onOverflow?(): void }): {
    push(chunk: Buffer | string): void
    pendingBytes(): number
  }
  encodeFrame(frame: unknown): string
  decodeFrame(line: string): Record<string, unknown> | null
}

export type ProcRowLike = { pid: number; ppid: number; ticks: number; command: string }

export type ProcModule = {
  parseProcStat(text: string): { pid: number; ppid: number; ticks: number } | null
  parseListeningInodes(text: string): Set<string>
  socketInode(link: string): string | null
  readProcessTable(procRoot: string): ProcRowLike[] | null
  subtreeLiveReason(
    root: number,
    rows: ProcRowLike[],
    listening: Set<number>,
    cpuByPid: Map<number, number>,
  ): string | null
  snapshot(options: {
    procRoot: string
    pidDir: string
    keys: string[]
    sampleMs?: number
    uid?: number
  }): Promise<Record<string, string | null>>
  survivorPids(options: {
    procRoot: string
    pidDir: string
    cliSessionId: string
    key: string
    uid?: number
    selfPid: number
  }): number[]
  endAllSessions(options: {
    procRoot: string
    pidDir: string | null
    uid?: number
    selfPid: number
    kill?: (pid: number, signal: string) => void
  }): number[]
}

export type SessionsModule = {
  MAX_SESSION_WRITE_BYTES: number
  ensureSessionDir(options: { home: string; uid?: number; profile: string }): string
  writeSessionFiles(dir: string, files: unknown): string[]
  removeSessionEntries(dir: string, names: unknown): void
  clearSessionDir(dir: string): void
}

/** The slice of a `net.Socket` the relay uses, for a stand-in. */
export type RelaySocketLike = {
  on(event: string, listener: (...args: never[]) => void): unknown
  off(event: string, listener: (...args: never[]) => void): unknown
  pause(): unknown
  resume(): unknown
  write(chunk: Buffer): unknown
  end(): unknown
  destroy(): unknown
  setTimeout(ms: number, callback: () => void): unknown
  readableEnded: boolean
}

export type RelayModule = {
  MAX_AGENT_STATE_BYTES_PER_CONNECTION: number
  parseAuthLine(line: string): string | null
  relayAgentStateConnection(socket: RelaySocketLike, send: (line: string) => void): void
  createMcpMux(send: (frame: Record<string, unknown>) => void): {
    accept(socket: RelaySocketLike): void
    handleFromMain(frame: Record<string, unknown>): void
    size(): number
    closeAll(): void
  }
}

export type LoginEnvModule = {
  keepVariable(name: string): boolean
  parseEnvDump(bytes: Buffer | string): Record<string, string> | null
  loginShell(uid: number, passwd?: () => string): string
}

export type FilesModule = {
  checkTreePath(path: unknown): boolean
  ensureTree(options: {
    appDir: string
    name: string
    digest: string
    files?: Array<{ path: string; b64: string; executable?: boolean }>
  }): { root: string; current: boolean }
}

export type RunModule = {
  checkRunRequest(request: Record<string, unknown>): string | null
  decodeStdin(stdinB64: unknown): Buffer | null | undefined
  runArgv(request: {
    argv: string[]
    cwd?: string
    env?: Record<string, string>
    timeoutMs: number | null
    stdin?: Buffer
  }): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>
}

export type SocketsModule = {
  ensureSocketDir(options: {
    env: Record<string, string | undefined>
    uid: number
    profile: string
    base?: string
  }): string
  runtimeBase(options: { env: Record<string, string | undefined>; uid: number }): string
}

export type CliDetectModule = {
  resolveBinary(binary: string, env: Record<string, string>): { path: string } | null
}

export async function loadHelperModule<T>(relative: string): Promise<T> {
  return (await import(pathToFileURL(join(HELPER_DIR, relative)).href)) as T
}
