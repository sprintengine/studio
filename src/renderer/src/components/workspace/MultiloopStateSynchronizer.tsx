import { useWorkspaceStore } from '../../store/workspaceStore'
import type { MultiloopState, MultiloopStateDisplayError } from '../../types/workspace'
import { parseMultiloopStateFile } from '../../utils/multiloopStateFile'
import {
  createRunStateSynchronizer,
  type RunStateReadResult,
  type RunStateSynchronizerConfig,
} from './runStateSynchronizer'

export const MULTILOOP_STATE_SYNC_EVENT = 'multicode:multiloop-state-sync'

export type MultiloopStateSyncEventDetail =
  | { workspaceId: string; status: 'ok'; statePath: string }
  | { workspaceId: string; status: 'error'; statePath: string; error: MultiloopStateDisplayError }

const syncSnapshots = new Map<string, MultiloopStateSyncEventDetail>()

function dispatchMultiloopStateSync(detail: MultiloopStateSyncEventDetail): void {
  syncSnapshots.set(detail.workspaceId, detail)
  window.dispatchEvent(new CustomEvent<MultiloopStateSyncEventDetail>(MULTILOOP_STATE_SYNC_EVENT, { detail }))
}

export function getMultiloopStateSyncSnapshot(workspaceId: string): MultiloopStateSyncEventDetail | null {
  return syncSnapshots.get(workspaceId) ?? null
}

function toIoDisplayError(message: string): MultiloopStateDisplayError {
  return { title: 'Missing Multiloop state', message }
}

async function readMultiloopStateFromDisk(
  statePath: string
): Promise<RunStateReadResult<MultiloopState, MultiloopStateDisplayError>> {
  let content: string
  try {
    content = await window.api.readfile(statePath)
  } catch (error) {
    return {
      ok: false,
      kind: 'io',
      message: error instanceof Error ? error.message : String(error),
    }
  }
  const parsed = parseMultiloopStateFile(content)
  if (!parsed.ok) {
    return { ok: false, kind: 'parse', message: parsed.error.message, error: parsed.error }
  }
  return { ok: true, state: parsed.state, signature: content }
}

// Exported so deterministic renderer tests can exercise the same read +
// onParseError / onReadError wiring the FC uses, without rendering React.
export const multiloopStateSynchronizerConfig: RunStateSynchronizerConfig<MultiloopState, MultiloopStateDisplayError> = {
  logScope: 'MultiloopState',
  watchFileName: 'state.json',
  selectStatePath: (workspace) => workspace?.multiloopContext?.statePath ?? null,
  read: readMultiloopStateFromDisk,
  applyToStore: (workspaceId, state) => {
    useWorkspaceStore.getState().setMultiloopState(workspaceId, state)
  },
  onSyncOk: ({ workspaceId, statePath }) => {
    dispatchMultiloopStateSync({ workspaceId, status: 'ok', statePath })
  },
  onParseError: ({ workspaceId, statePath, error }) => {
    // Forward the parser's original typed display error so the UI keeps the
    // 'Invalid Multiloop JSON' / 'Invalid Multiloop state' titles and path
    // metadata rather than collapsing every parse failure to 'Missing'.
    dispatchMultiloopStateSync({ workspaceId, status: 'error', statePath, error })
  },
  onReadError: ({ workspaceId, statePath, message }) => {
    dispatchMultiloopStateSync({
      workspaceId,
      status: 'error',
      statePath,
      error: toIoDisplayError(message),
    })
  },
  successPerfPayload: (state) => ({
    loop: state.loop.displayName,
    milestoneCount: state.roadmap.length,
    taskCount: state.tasks.length,
    artifactCount: state.artifacts.length,
  }),
}

const MultiloopStateSynchronizer = createRunStateSynchronizer(multiloopStateSynchronizerConfig)

export default MultiloopStateSynchronizer
