import { cancelActiveContentSearch, searchContent, searchFiles } from './filesystem-search'
import { isMissingPathError, pathExists } from './filesystem-workspace'

export function createFilesystemWatchSearchHandlers() {
  return {
    pathExists,
    isMissingPathError,
    searchFiles,
    searchContent,
    cancelActiveContentSearch,
  }
}
