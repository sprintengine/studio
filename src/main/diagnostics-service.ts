import { appendFile, mkdir } from 'fs/promises'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'
import type { DiagnosticLogEntry, DiagnosticLogInput } from '../shared/electron-api'
import { studioPlatform } from '../server/platform/platform'

// The diagnostics log the server appends to. Opening its folder in the OS file
// manager is the shell's half (diagnostics-folder.ts).

export function getDiagnosticsLogDirectory(): string {
  return studioPlatform().paths.logsDir()
}

// The file's name before its date. The Studio server out of process writes
// `diagnostics-server-…` beside the shell's own, so two processes never append
// to one file.
let logName = 'diagnostics'

/** Name this process's diagnostics file; set once, by an entry, before anything is written. */
export function setDiagnosticsLogName(name: string): void {
  logName = name
}

function getDiagnosticsLogPath(timestamp = new Date()): string {
  const day = timestamp.toISOString().slice(0, 10)
  return join(getDiagnosticsLogDirectory(), `${logName}-${day}.jsonl`)
}

export async function writeDiagnosticLog(input: DiagnosticLogInput): Promise<DiagnosticLogEntry> {
  const timestamp = new Date()
  const logPath = getDiagnosticsLogPath(timestamp)
  const entry: DiagnosticLogEntry = {
    ...input,
    id: `diag-${timestamp.getTime()}-${randomBytes(4).toString('hex')}`,
    timestamp: timestamp.toISOString(),
    logPath,
  }

  await mkdir(dirname(logPath), { recursive: true })
  await appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf-8')
  return entry
}
