import type { MultiloopState, MultiloopWorkspaceContext } from '../types/workspace'
import {
  getMultiloopDirectoryPath,
  getMultiloopStateFilePath,
  parseMultiloopStateFile,
  slugifyMultiloopName,
} from './multiloopStateFile'

type CreateMultiloopWorkspaceArgs = {
  rootPath: string
  loopName: string
  finalGoal: string
  initializeState: (input: MultiloopInitInput) => Promise<MultiloopInitResult>
  readFile: (path: string) => Promise<string>
}

export class MultiloopWorkspaceCreationError extends Error {
  constructor(message: string) {
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

  const content = await readFile(initialized.data.statePath)
  const parsed = parseMultiloopStateFile(content)
  if (!parsed.ok) {
    throw new MultiloopWorkspaceCreationError(parsed.error.message)
  }

  const loopSlug = initialized.data.loopSlug || slugifyMultiloopName(trimmedLoopName)
  return {
    state: parsed.state,
    context: {
      loopName: initialized.data.loopName || trimmedLoopName,
      loopSlug,
      loopDirectoryPath: initialized.data.loopDirectory || getMultiloopDirectoryPath(trimmedRoot, loopSlug),
      statePath: initialized.data.statePath || getMultiloopStateFilePath(trimmedRoot, loopSlug),
    },
    created: initialized.data.created,
  }
}
