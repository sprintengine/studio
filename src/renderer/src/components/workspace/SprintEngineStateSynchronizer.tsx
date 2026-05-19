import { useWorkspaceStore } from '../../store/workspaceStore'
import { basename as getBaseName, parentPath as getParentDirectoryPath } from '../../utils/paths'
import { normalizeSprintEngineProjection } from '../../utils/sprintengine'
import type { SprintEngineState } from '../../types/workspace'
import { createRunStateSynchronizer, type RunStateReadResult } from './runStateSynchronizer'

type SprintEngineProjectionParseError = { message: string }

function sprintEngineStateSignature(state: SprintEngineState): string {
  const { projection, ...semanticState } = state
  return JSON.stringify({
    ...semanticState,
    projection: projection
      ? {
        ...projection,
        generatedAt: null,
      }
      : projection,
  })
}

async function readSprintEngineProjection(
  statePath: string,
  directoryName: string
): Promise<RunStateReadResult<SprintEngineState, SprintEngineProjectionParseError>> {
  try {
    const projectionResult = await window.api.readSprintEngineProjection(statePath)
    if (!projectionResult.ok) {
      return { ok: false, kind: 'io', message: projectionResult.message }
    }
    const parsed = normalizeSprintEngineProjection(projectionResult.data, directoryName)
    if (!parsed) {
      const message = 'Sprint Engine projection was malformed.'
      return { ok: false, kind: 'parse', message, error: { message } }
    }
    return { ok: true, state: parsed, signature: sprintEngineStateSignature(parsed) }
  } catch (error) {
    return {
      ok: false,
      kind: 'io',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

const SprintEngineStateSynchronizer = createRunStateSynchronizer<SprintEngineState, SprintEngineProjectionParseError>({
  logScope: 'SprintEngineState',
  watchFileName: 'projection.json',
  selectStatePath: (workspace) => workspace?.sprintEngineContext?.statePath ?? null,
  read: readSprintEngineProjection,
  applyToStore: (workspaceId, state) => {
    useWorkspaceStore.getState().setSprintEngineState(workspaceId, state)
  },
  successPerfPayload: (state) => ({
    team: state.name,
    taskCount: state.tasks.length,
    artifactCount: state.artifacts.length,
    source: state.projection?.source ?? 'unavailable',
  }),
  fallbackLabelFromDirectory: (directoryName) =>
    getBaseName(directoryName ? getParentDirectoryPath(directoryName) : directoryName) || directoryName,
})

export default SprintEngineStateSynchronizer
