import type { MultiloopAutoState } from '../../../../types/workspace'
import {
  MultiloopWorkspaceCreationError,
  createMultiloopWorkspace,
} from '../../../../utils/multiloopWorkspaceCreation'
import type { MultiloopControllerInput, MultiloopControllerPorts } from './types'

export class MultiloopControllerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MultiloopControllerError'
  }
}

export async function runMultiloopCreation(
  input: MultiloopControllerInput,
  ports: MultiloopControllerPorts,
): Promise<void> {
  const loopName = (input.loopName.trim() || input.workspaceName.trim() || 'Multiloop').trim()
  let created
  try {
    created = await createMultiloopWorkspace({
      rootPath: input.folderPath,
      loopName,
      finalGoal: input.finalGoal,
      initializeState: ports.initializeMultiloopState,
      readFile: ports.readFile,
    })
  } catch (error) {
    if (error instanceof MultiloopWorkspaceCreationError || error instanceof Error) {
      throw new MultiloopControllerError(error.message)
    }
    throw new MultiloopControllerError('Could not create the Multiloop workspace.')
  }

  const multiloopAutoState: Partial<MultiloopAutoState> = {
    cliPermissionPreset: input.cliPermissionPreset,
  }
  ports.addWorkspace(ports.createMultiloopTemplate(), {
    name: loopName,
    folderPath: input.folderPath,
    multiloopState: created.state,
    multiloopContext: created.context,
    multiloopAutoState,
    windowId: input.workspaceWindowId,
  })
}
