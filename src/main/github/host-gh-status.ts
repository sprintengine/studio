import type { RunOutcome } from '../process-run'
import { parseGhVersion, type HostGhStatus } from '../../shared/host-gh'

// One WSL machine's `gh`, asked through the machine itself so its login PATH
// answers, as the Version control tab asks each machine's git. Two read-only
// commands: `gh --version`, then whether `gh` holds a token. The token is sent
// to /dev/null on the machine and never crosses back. Nothing is installed
// and nobody is signed in.

const PROBE_TIMEOUT_MS = 15_000

/** The shell's "command not found". Any other failure is the machine not answering, which is not a verdict. */
const NOT_FOUND = 127

export async function probeHostGh(host: {
  runCommand(argv: readonly string[], options: { timeoutMs: number }): Promise<RunOutcome>
}): Promise<HostGhStatus | null> {
  const version = await host.runCommand(['gh', '--version'], { timeoutMs: PROBE_TIMEOUT_MS })
  if (version.code === NOT_FOUND) return { installed: false, version: null, signedIn: null }
  if (version.timedOut || version.spawnFailed || version.code !== 0) return null
  // `GH_PROMPT_DISABLED` so a `gh` that wanted to ask something fails instead.
  const auth = await host.runCommand(['sh', '-c', 'GH_PROMPT_DISABLED=1 gh auth token >/dev/null 2>&1'], {
    timeoutMs: PROBE_TIMEOUT_MS,
  })
  const signedIn = auth.timedOut || auth.spawnFailed ? null : auth.code === 0
  return { installed: true, version: parseGhVersion(version.stdout), signedIn }
}
