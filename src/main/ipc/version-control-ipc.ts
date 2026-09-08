import type { IpcMain } from 'electron'

import type { VersionControlProviderProbe } from '../../shared/version-control'
import { probeBinaryVersion } from '../cli-runtime-install'
import { createDefaultGhRunner } from '../review/providers/github-pr-provider'
import {
  parseGhAuthLogin,
  probeVersionControlProviders,
  type VersionControlProbeDeps,
} from './version-control-probe'

// The real probes: the same machinery agent-CLI detection uses for versions, and
// the same gh runner the review paths use for auth (so a GUI-launched app finds a
// Homebrew/nvm gh, and gh's own credential store is the single auth source).
function createVersionControlProbeDeps(): VersionControlProbeDeps {
  const gh = createDefaultGhRunner()
  return {
    probeVersion: (binary) => probeBinaryVersion(binary),
    async readGhLogin() {
      // A non-zero exit is gh's own "not logged in" verdict.
      const status = await gh.run(['auth', 'status'])
      if (!status.found || status.code !== 0) return null
      return parseGhAuthLogin(`${status.stdout}\n${status.stderr}`)
    },
  }
}

export function registerVersionControlIpc(
  ipcMain: IpcMain,
  deps: VersionControlProbeDeps = createVersionControlProbeDeps(),
): void {
  // Read-only and argument-free: the channel probes exactly the two providers the
  // product integrates, so no renderer-supplied value can reach a spawn.
  ipcMain.handle('version-control:probe-providers', (): Promise<VersionControlProviderProbe[]> =>
    probeVersionControlProviders(deps),
  )
}
