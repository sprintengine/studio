import { useEffect, useMemo, useRef, useState } from 'react'
import {
  scanBacklog,
  type BacklogFilesystemAdapter,
  type BacklogScanResult,
} from '../../../utils/backlog'
import {
  hydrateBacklogScanResult,
} from '../../../utils/backlogObjects'

const EMPTY: BacklogScanResult = { state: 'missing-folder', items: [], errors: [] }

const adapter: BacklogFilesystemAdapter = {
  pathExists: (path) => window.api.pathExists(path),
  readdir: (path) => window.api.readdir(path),
  readfile: (path) => window.api.readfile(path),
  statPath: (path) => window.api.statPath(path),
}

// Read-only backlog scan for the new-workspace Sprint Engine source picker.
// Hydrates persisted triage/links/status from items.json in memory exactly like
// the Backlog panel, but never writes back — a source picker must not mutate the
// store. A missing or unreadable items.json degrades to the raw file scan rather
// than blocking the picker.
async function scanBacklogReadOnly(folderPath: string): Promise<BacklogScanResult> {
  const scanned = await scanBacklog(folderPath, adapter)
  const result = await window.api.readBacklogObjectStore(folderPath).catch(() => null)
  if (!result?.ok) return scanned
  return hydrateBacklogScanResult(scanned, result.store)
}

export function useBacklogScan(folderPath: string | null): {
  isScanning: boolean
  result: BacklogScanResult
} {
  const [result, setResult] = useState<BacklogScanResult>(EMPTY)
  const [isScanning, setIsScanning] = useState(false)
  const tokenRef = useRef(0)

  useEffect(() => {
    if (!folderPath) {
      tokenRef.current += 1
      setResult(EMPTY)
      setIsScanning(false)
      return
    }
    const token = (tokenRef.current += 1)
    setIsScanning(true)
    void scanBacklogReadOnly(folderPath)
      .then((next) => {
        if (token !== tokenRef.current) return
        setResult(next)
      })
      .catch((error: unknown) => {
        if (token !== tokenRef.current) return
        setResult({
          state: 'error',
          items: [],
          errors: [{ relativePath: 'backlog/', message: error instanceof Error ? error.message : String(error) }],
        })
      })
      .finally(() => {
        if (token === tokenRef.current) setIsScanning(false)
      })
  }, [folderPath])

  return useMemo(() => ({ isScanning, result }), [isScanning, result])
}
