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
  runArgv(request: {
    argv: string[]
    cwd?: string
    env?: Record<string, string>
    timeoutMs: number | null
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
