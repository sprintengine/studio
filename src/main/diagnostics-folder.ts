import { shell } from 'electron'
import { mkdir } from 'fs/promises'

import { getDiagnosticsLogDirectory } from './diagnostics-service'

/** Show the diagnostics log folder in the OS file manager, creating it first so there is something to show. */
export async function openDiagnosticsLogsFolder(): Promise<{ opened: true; path: string }> {
  const logDirectory = getDiagnosticsLogDirectory()
  await mkdir(logDirectory, { recursive: true })
  const errorMessage = await shell.openPath(logDirectory)
  if (errorMessage) throw new Error(errorMessage)
  return { opened: true, path: logDirectory }
}
