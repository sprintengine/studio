import { useEffect, useState } from 'react'

import type { ConversationImportFolder } from '../../../../shared/electron-api'

// Apart from the picker so the shell can ask whether there is anything to
// offer without loading the list that offers it.

export type ConversationImportScan =
  | { status: 'loading' }
  | { status: 'ready'; folders: ConversationImportFolder[] }
  | { status: 'error'; message: string }

/** Read what the CLIs saved, once per mount. */
export function useConversationImportScan(enabled = true): ConversationImportScan {
  const [scan, setScan] = useState<ConversationImportScan>({ status: 'loading' })
  useEffect(() => {
    if (!enabled) return
    let disposed = false
    void window.api
      .scanImportableConversations()
      .then((result) => {
        if (disposed) return
        setScan(result.ok ? { status: 'ready', folders: result.folders } : { status: 'error', message: result.message })
      })
      .catch((error: unknown) => {
        if (!disposed) setScan({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      })
    return () => {
      disposed = true
    }
  }, [enabled])
  return scan
}
