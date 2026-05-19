import { useEffect, useRef, type FC } from 'react'
import { useWorkspaceFolderStatus } from '../../hooks/useWorkspaceFolderStatus'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { basename as getBaseName, parentPath as getParentDirectoryPath } from '../../utils/paths'
import type { Workspace } from '../../types/workspace'

const RUN_STATE_WATCH_DEBOUNCE_MS = 120
const RUN_STATE_RECOVERY_INITIAL_MS = 10_000
const RUN_STATE_WATCH_RECOVERY_INITIAL_MS = 60_000
const RUN_STATE_RECOVERY_MAX_MS = 120_000
const RUN_STATE_UNCHANGED_LOG_INTERVAL_MS = 30_000

export type RunStateRefreshCause = 'initial' | 'watch' | 'recovery'

export type RunStateReadOk<TState> = {
  ok: true
  state: TState
  signature: string
}

export type RunStateReadIoError = {
  ok: false
  kind: 'io'
  message: string
}

export type RunStateReadParseError<TParseError> = {
  ok: false
  kind: 'parse'
  message: string
  /** The original typed parser error (e.g. MultiloopStateDisplayError) so callers can preserve title/path metadata. */
  error: TParseError
}

export type RunStateReadResult<TState, TParseError = unknown> =
  | RunStateReadOk<TState>
  | RunStateReadIoError
  | RunStateReadParseError<TParseError>

export type RunStateSynchronizerConfig<TState, TParseError = unknown> = {
  /** Log scope passed to logPerfEvent — e.g. 'SprintEngineState' or 'MultiloopState'. */
  logScope: string
  /** Watch only for changes to this file basename. */
  watchFileName: string
  /** Workspace → state-file path. Returning null/undefined disables sync for that workspace. */
  selectStatePath: (workspace: Workspace | null) => string | null | undefined
  /** Read + parse the state at the given path. Should not throw; return a tagged result. */
  read: (statePath: string, directoryName: string) => Promise<RunStateReadResult<TState, TParseError>>
  /** Apply parsed state to the workspace store. */
  applyToStore: (workspaceId: string, state: TState) => void
  /** Optional hook fired on successful sync (e.g. dispatch a custom event). */
  onSyncOk?: (input: { workspaceId: string; statePath: string }) => void
  /** Optional hook fired on parse error — receives the original typed parser error. */
  onParseError?: (input: { workspaceId: string; statePath: string; error: TParseError }) => void
  /** Optional hook fired on IO error (parse-error vs IO-error distinction). */
  onReadError?: (input: { workspaceId: string; statePath: string; message: string }) => void
  /** Optional payload contributed to the perf log on successful refresh. */
  successPerfPayload?: (state: TState) => Record<string, unknown>
  /** Optional label producer for the perf log when the state is missing. */
  fallbackLabelFromDirectory?: (directoryName: string) => string
}

export function createRunStateSynchronizer<TState, TParseError = unknown>(
  config: RunStateSynchronizerConfig<TState, TParseError>
): FC<{ workspaceId: string }> {
  const Synchronizer: FC<{ workspaceId: string }> = ({ workspaceId }) => {
    const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId) ?? null)
    const { folderReadyPath } = useWorkspaceFolderStatus(workspaceId)
    const lastSyncedSignatureRef = useRef<string | null>(null)
    const readCountRef = useRef(0)
    const lastUnchangedLogAtRef = useRef(0)
    const statePath = config.selectStatePath(workspace) || null

    useEffect(() => {
      if (!statePath || !folderReadyPath) return

      let disposed = false
      let stopWatching: (() => Promise<void>) | null = null
      let debounce: number | null = null
      let recoveryTimeout: number | null = null
      let recoveryDelayMs = RUN_STATE_RECOVERY_INITIAL_MS
      let watching = false
      const directoryPath = getParentDirectoryPath(statePath)
      const directoryName = getBaseName(directoryPath)

      lastSyncedSignatureRef.current = null
      readCountRef.current = 0
      lastUnchangedLogAtRef.current = 0

      const clearRecoveryTimeout = () => {
        if (recoveryTimeout === null) return
        window.clearTimeout(recoveryTimeout)
        recoveryTimeout = null
      }

      const resetRecoveryDelay = () => {
        recoveryDelayMs = watching ? RUN_STATE_WATCH_RECOVERY_INITIAL_MS : RUN_STATE_RECOVERY_INITIAL_MS
      }

      const backOffRecoveryDelay = () => {
        recoveryDelayMs = Math.min(recoveryDelayMs * 2, RUN_STATE_RECOVERY_MAX_MS)
      }

      const scheduleRecovery = () => {
        clearRecoveryTimeout()
        if (disposed || document.hidden) return
        recoveryTimeout = window.setTimeout(() => {
          recoveryTimeout = null
          void readExternalState('recovery')
        }, recoveryDelayMs)
      }

      const fallbackLabel = () => config.fallbackLabelFromDirectory?.(directoryName) ?? directoryName

      const readExternalState = async (cause: RunStateRefreshCause) => {
        const startedAt = performance.now()
        readCountRef.current += 1
        const result = await config.read(statePath, directoryName)
        if (disposed) return

        if (!result.ok) {
          if (cause === 'recovery') backOffRecoveryDelay()
          if (result.kind === 'parse') {
            config.onParseError?.({ workspaceId, statePath, error: result.error })
          } else {
            config.onReadError?.({ workspaceId, statePath, message: result.message })
          }
          logPerfEvent(config.logScope, 'refresh-error', {
            workspaceId,
            label: fallbackLabel(),
            cause,
            elapsedMs: Math.round(performance.now() - startedAt),
            message: result.message,
            readCount: readCountRef.current,
            kind: result.kind,
          })
          scheduleRecovery()
          return
        }

        const changed = result.signature !== lastSyncedSignatureRef.current
        if (!changed) {
          if (cause === 'recovery') backOffRecoveryDelay()
          const now = Date.now()
          if (now - lastUnchangedLogAtRef.current >= RUN_STATE_UNCHANGED_LOG_INTERVAL_MS) {
            lastUnchangedLogAtRef.current = now
            logPerfEvent(config.logScope, 'refresh', {
              workspaceId,
              label: fallbackLabel(),
              cause,
              elapsedMs: Math.round(performance.now() - startedAt),
              changed: false,
              readCount: readCountRef.current,
            })
          }
          scheduleRecovery()
          return
        }

        resetRecoveryDelay()
        lastSyncedSignatureRef.current = result.signature
        config.applyToStore(workspaceId, result.state)
        config.onSyncOk?.({ workspaceId, statePath })
        logPerfEvent(config.logScope, 'refresh', {
          workspaceId,
          cause,
          elapsedMs: Math.round(performance.now() - startedAt),
          changed: true,
          readCount: readCountRef.current,
          ...(config.successPerfPayload?.(result.state) ?? {}),
        })
        scheduleRecovery()
      }

      const startWatching = async () => {
        try {
          stopWatching = await window.api.watchPath(directoryPath, (event) => {
            if (event.path && !event.path.endsWith(config.watchFileName)) return
            if (debounce !== null) window.clearTimeout(debounce)
            debounce = window.setTimeout(() => { void readExternalState('watch') }, RUN_STATE_WATCH_DEBOUNCE_MS)
          })
          watching = true
          resetRecoveryDelay()
          scheduleRecovery()

          if (disposed && stopWatching) {
            void stopWatching()
            stopWatching = null
          }
        } catch {
          // WSL / network-backed / unsupported FS — recovery polling still refreshes state.
        }
      }

      const handleVisibilityChange = () => {
        if (document.hidden) {
          clearRecoveryTimeout()
          return
        }
        resetRecoveryDelay()
        void readExternalState('recovery')
      }

      document.addEventListener('visibilitychange', handleVisibilityChange)
      void readExternalState('initial')
      void startWatching()

      return () => {
        disposed = true
        if (debounce !== null) window.clearTimeout(debounce)
        clearRecoveryTimeout()
        document.removeEventListener('visibilitychange', handleVisibilityChange)
        if (stopWatching) void stopWatching()
      }
    }, [folderReadyPath, statePath, workspaceId])

    return null
  }

  Synchronizer.displayName = `RunStateSynchronizer(${config.logScope})`
  return Synchronizer
}
