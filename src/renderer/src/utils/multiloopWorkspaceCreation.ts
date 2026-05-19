import type { MultiloopState, MultiloopStateDisplayError, MultiloopWorkspaceContext } from '../types/workspace'
import { parseMultiloopStateFile } from './multiloopStateFile'
import {
  RunWorkspaceStateParseError,
  loadRunWorkspaceState,
} from './runWorkspaceCreation'

type CreateMultiloopWorkspaceArgs = {
  rootPath: string
  loopName: string
  finalGoal: string
  initializeState: (input: MultiloopInitInput) => Promise<MultiloopInitResult>
  readFile: (path: string) => Promise<string>
}

export class MultiloopWorkspaceCreationError extends Error {
  constructor(message: string, readonly displayError?: MultiloopStateDisplayError) {
    super(message)
    this.name = 'MultiloopWorkspaceCreationError'
  }
}

export type CreatedMultiloopWorkspace = {
  state: MultiloopState
  context: MultiloopWorkspaceContext
  created: boolean
}

export async function createMultiloopWorkspace({
  rootPath,
  loopName,
  finalGoal,
  initializeState,
  readFile,
}: CreateMultiloopWorkspaceArgs): Promise<CreatedMultiloopWorkspace> {
  const trimmedRoot = rootPath.trim()
  const trimmedLoopName = loopName.trim()
  const trimmedFinalGoal = finalGoal.trim()

  if (!trimmedRoot) throw new MultiloopWorkspaceCreationError('Choose a folder before creating a Multiloop workspace.')
  if (!trimmedLoopName) throw new MultiloopWorkspaceCreationError('Enter a loop name.')
  if (!trimmedFinalGoal) throw new MultiloopWorkspaceCreationError('Enter a final goal.')

  const initialized = await initializeState({
    workspaceRoot: trimmedRoot,
    loopName: trimmedLoopName,
    finalGoal: trimmedFinalGoal,
  })

  if (!initialized.ok) {
    throw new MultiloopWorkspaceCreationError(initialized.message || 'Could not initialize the Multiloop state.')
  }

  try {
    const { state, context } = await loadRunWorkspaceState<MultiloopState, MultiloopStateDisplayError>({
      kind: 'multiloop',
      rootPath: trimmedRoot,
      name: trimmedLoopName,
      statePathOverride: initialized.data.statePath,
      slugOverride: initialized.data.loopSlug,
      directoryOverride: initialized.data.loopDirectory,
      displayNameOverride: initialized.data.loopName,
      readFile,
      parser: parseMultiloopStateFile,
    })

    return {
      state,
      context: {
        loopName: context.name,
        loopSlug: context.slug,
        loopDirectoryPath: context.directoryPath,
        statePath: context.statePath,
      },
      created: initialized.data.created,
    }
  } catch (error) {
    if (error instanceof RunWorkspaceStateParseError) {
      const displayError = error.cause as MultiloopStateDisplayError
      throw new MultiloopWorkspaceCreationError(displayError.message, displayError)
    }
    throw error
  }
}
