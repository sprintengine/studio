import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

// `run/server.json`: what a detached server (an SSH machine's, phase 8) says
// about itself for the next client. The connect session's probe prints it,
// the relay reads where the front door is from it, and a desktop decides
// from it whether to attach, upgrade or stop (spec 5.6). It holds no secret:
// the owner token is a file of its own beside it.

export type DetachedServerRecord = {
  v: 1
  pid: number
  version: string
  /** `bootstrap`: started by a desktop, which may upgrade it. Anything else is external, and never replaced unasked. */
  origin: 'bootstrap' | 'cli' | 'systemd' | 'launchd'
  startedBy: string
  startedAt: string
  /** This machine (its machine id, else its host name), so a home shared over NFS says which machine runs it. */
  hostId: string
  environmentId: string
  /** The front door's bridge socket, which the relay proves itself on. */
  socketPath: string
  /** The backend wire the server speaks (`BACKEND_WIRE_VERSION`). */
  backendWire: number
  dataDir: string
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** This machine: its machine id, else its host name. */
export function readHostId(read: (path: string) => string | null = readText): string {
  const id = read('/etc/machine-id')?.trim()
  return id && /^[0-9a-f]{16,64}$/u.test(id) ? id : `host:${hostname()}`
}

/** Written whole under another name, then renamed into place, 0600, so a reader never sees half of one. */
export function writeServerRecord(runDir: string, record: DetachedServerRecord): void {
  const path = join(runDir, 'server.json')
  const staged = `${path}.${process.pid}`
  writeFileSync(staged, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  renameSync(staged, path)
}

export function readServerRecordFile(runDir: string): DetachedServerRecord | null {
  const text = readText(join(runDir, 'server.json'))
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as DetachedServerRecord
    return typeof parsed === 'object' && parsed !== null && typeof parsed.pid === 'number' ? parsed : null
  } catch {
    return null
  }
}
