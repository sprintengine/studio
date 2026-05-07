import { app, shell } from 'electron'
import { appendFile, mkdir } from 'fs/promises'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'
import type { DiagnosticLogEntry, DiagnosticLogInput } from '../shared/electron-api'

function getDiagnosticsLogDirectory(): string {
  return app.getPath('logs')
}

function getDiagnosticsLogPath(timestamp = new Date()): string {
  const day = timestamp.toISOString().slice(0, 10)
  return join(getDiagnosticsLogDirectory(), `diagnostics-${day}.jsonl`)
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

export async function openDiagnosticsLogsFolder(): Promise<{ opened: true; path: string }> {
  const logDirectory = getDiagnosticsLogDirectory()
  await mkdir(logDirectory, { recursive: true })
  const errorMessage = await shell.openPath(logDirectory)
  if (errorMessage) throw new Error(errorMessage)
  return { opened: true, path: logDirectory }
}
