import type { IpcMain } from 'electron'

import type { VersionControlProviderProbe } from '../../shared/version-control'
import { binaryVersionProbeFrom, parseProbeOutput, probeBinaryVersion } from '../cli-runtime-install'
import { hostRegistry } from '../hosts/host-registry'
import { createDefaultGhRunner } from '../github/gh'
import { parseGhAuthLogin, probeVersionControlProviders, type VersionControlProbeDeps } from './version-control-probe'

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
    // Each enabled WSL machine's own git: the one a workspace on that machine
    // runs. Asked through the machine itself, so it is that distribution's
    // login PATH that answers.
    async listGitMachines() {
      const { hosts } = await hostRegistry().list()
      return hosts
        .filter((summary) => summary.kind === 'wsl')
        .map((summary) => ({
          hostId: summary.id,
          label: summary.label,
          async probeGit() {
            const outcome = await hostRegistry().get(summary.id).runCommand(['git', '--version'], { timeoutMs: 15_000 })
            // 127 is the shell's "command not found"; any other failure is the
            // distribution not answering, which is not a verdict about git.
            if (outcome.code === 127) return { outcome: 'not_installed' as const }
            if (outcome.timedOut || outcome.spawnFailed || outcome.code !== 0)
              return { outcome: 'probe_failed' as const }
            return binaryVersionProbeFrom({ parsed: parseProbeOutput(0, outcome.stdout), inconclusive: false })
          },
        }))
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
