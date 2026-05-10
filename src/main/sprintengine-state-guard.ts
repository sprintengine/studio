import { lstat, readdir, realpath, stat } from 'fs/promises'
import { basename, dirname, resolve } from 'path'
import { isMissingPathError } from './filesystem-workspace'

function isSprintEngineStateFilePath(input: string): boolean {
  const statePath = resolve(input)
  const teamDirectory = dirname(statePath)
  const sprintEngineDirectory = dirname(teamDirectory)
  const multiCodeDirectory = dirname(sprintEngineDirectory)
  const workspaceRoot = dirname(multiCodeDirectory)

  return (
    basename(statePath) === 'state.yaml'
    && basename(sprintEngineDirectory) === 'sprintengine'
    && basename(multiCodeDirectory) === '.multi-code'
    && workspaceRoot !== multiCodeDirectory
  )
}

async function getRealMutationTargetPath(targetPath: string): Promise<string | null> {
  try {
    await lstat(targetPath)
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error
    }

    const parentDirectory = dirname(resolve(targetPath))
    try {
      return resolve(await realpath(parentDirectory), basename(targetPath))
    } catch (parentError) {
      if (isMissingPathError(parentError)) {
        return null
      }
      throw parentError
    }
  }

  try {
    return await realpath(targetPath)
  } catch (error) {
    if (isMissingPathError(error)) {
      return null
    }
    throw error
  }
}

async function getExistingDirectoryPath(targetPath: string): Promise<string | null> {
  try {
    const targetStats = await stat(targetPath)
    return targetStats.isDirectory() ? targetPath : null
  } catch (error) {
    if (isMissingPathError(error)) {
      return null
    }
    throw error
  }
}

async function directorySubtreeContainsSprintEngineStatePath(directoryPath: string): Promise<boolean> {
  const visitedRealDirectories = new Set<string>()

  const visit = async (currentDirectory: string): Promise<boolean> => {
    let realCurrentDirectory: string | null = null
    try {
      realCurrentDirectory = await realpath(currentDirectory)
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error
      }
    }

    if (realCurrentDirectory) {
      if (visitedRealDirectories.has(realCurrentDirectory)) {
        return false
      }
      visitedRealDirectories.add(realCurrentDirectory)
    }

    let entries
    try {
      entries = await readdir(currentDirectory, { withFileTypes: true })
    } catch (error) {
      if (isMissingPathError(error)) {
        return false
      }
      throw error
    }

    for (const entry of entries) {
      const entryPath = resolve(currentDirectory, entry.name)
      if (entry.name === 'state.yaml' && isSprintEngineStateFilePath(entryPath)) {
        return true
      }
      if (entry.isDirectory() && await visit(entryPath)) {
        return true
      }
    }

    return false
  }

  return visit(directoryPath)
}

export async function assertNotDirectSprintEngineStateMutation(targetPath: string): Promise<void> {
  const realTargetPath = await getRealMutationTargetPath(targetPath)
  if (isSprintEngineStateFilePath(targetPath) || (realTargetPath && isSprintEngineStateFilePath(realTargetPath))) {
    throw new Error('Sprint Engine state files must be updated through the Sprint Engine tool.')
  }

  const existingDirectoryPath = await getExistingDirectoryPath(targetPath)
  if (!existingDirectoryPath) {
    return
  }

  if (await directorySubtreeContainsSprintEngineStatePath(existingDirectoryPath)) {
    throw new Error('Sprint Engine state files must be updated through the Sprint Engine tool.')
  }

  const realDirectoryPath = realTargetPath && realTargetPath !== resolve(existingDirectoryPath)
    ? await getExistingDirectoryPath(realTargetPath)
    : null
  if (realDirectoryPath && await directorySubtreeContainsSprintEngineStatePath(realDirectoryPath)) {
    throw new Error('Sprint Engine state files must be updated through the Sprint Engine tool.')
  }
}
