import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  return hydrateBacklogScanResult(scanned, result.store, folderPath)
}

export function useBacklogScan(folderPath: string | null): {
  isScanning: boolean
  result: BacklogScanResult
  /** Re-run the same scan on demand (the header Rescan affordance). Resolves
   *  when this scan lands or is superseded by a newer one. */
  rescan: () => Promise<void>
} {
  const [result, setResult] = useState<BacklogScanResult>(EMPTY)
  const [isScanning, setIsScanning] = useState(false)
  const tokenRef = useRef(0)

  const rescan = useCallback(async (): Promise<void> => {
    if (!folderPath) {
      tokenRef.current += 1
      setResult(EMPTY)
      setIsScanning(false)
      return
    }
    const token = (tokenRef.current += 1)
    setIsScanning(true)
    try {
      const next = await scanBacklogReadOnly(folderPath)
      if (token === tokenRef.current) setResult(next)
    } catch (error) {
      if (token === tokenRef.current) {
        setResult({
          state: 'error',
          items: [],
          errors: [{ relativePath: 'backlog/', message: error instanceof Error ? error.message : String(error) }],
        })
      }
    } finally {
      if (token === tokenRef.current) setIsScanning(false)
    }
  }, [folderPath])

  useEffect(() => {
    void rescan()
  }, [rescan])

  return useMemo(() => ({ isScanning, result, rescan }), [isScanning, result, rescan])
}
