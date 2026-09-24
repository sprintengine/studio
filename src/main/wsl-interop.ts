// =============================================================================
// Crossing the Windows ↔ WSL boundary
//
// An agent "run through WSL" is a Linux process started by `wsl.exe` from a
// Windows app. Two things do not survive that crossing on their own, and every
// launch path that hands such an agent something has to deal with both:
//
//   - Paths. A Linux shell cannot open `C:\Users\…` or `\\wsl$\Distro\…`; it
//     needs `/mnt/c/Users/…` and `/…`. `toWslPath` in `shared/host-paths.ts`
//     is the one conversion.
//   - Environment. Variables do not cross between Windows and Linux processes
//     unless `WSLENV` names them — neither from the pty's Windows env into the
//     Linux shell, nor from a Linux hook back out to a Windows program it runs
//     through interop. `withWslSharedEnv` and `wslInteropEnv` name them.
// =============================================================================

// `WSLENV` is a colon-separated list of `NAME` or `NAME/flags` entries.
function wslEnvNames(value: string | undefined): string[] {
  return (value ?? '')
    .split(':')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

/** `names` appended to an existing `WSLENV` value, each once. */
export function mergeWslEnv(existing: string | undefined, names: readonly string[]): string {
  const entries = wslEnvNames(existing)
  const present = new Set(entries.map((entry) => entry.split('/')[0]))
  for (const name of names) {
    if (present.has(name)) continue
    present.add(name)
    entries.push(name)
  }
  return entries.join(':')
}

/**
 * The env a Windows process hands `wsl.exe`, with `names` shared into the Linux
 * side. Values cross verbatim (no `/p` path flag): the ids are opaque and the
 * socket address is a Windows named pipe that only a Windows program — the
 * host runtime a WSL hook calls back out to — ever opens.
 *
 * Windows env keys are case-insensitive, so an existing `WSLENV` under any
 * spelling is merged into rather than duplicated.
 */
export function withWslSharedEnv(env: Record<string, string>, names: readonly string[]): Record<string, string> {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === 'WSLENV') ?? 'WSLENV'
  const merged = mergeWslEnv(env[key], names)
  return merged ? { ...env, [key]: merged } : env
}

/**
 * The environment a Linux shell under WSL hands a Windows executable it starts,
 * with `WSLENV` naming every variable in it.
 *
 * Interop copies a Linux variable into the Windows process only when `WSLENV`
 * lists it, and drops the rest without a word. For this app's own binary the
 * loss is not a missing setting: without `ELECTRON_RUN_AS_NODE` the binary
 * starts as the app instead of as Node, which is a second launch, and a second
 * launch brings the running window forward. An agent's hook fires on every tool
 * call, so the window was pulled in front of whatever the person was doing.
 *
 * `shared` names variables the Linux session already holds and the Windows
 * program also needs, such as the agent identity the launch shared into WSL
 * (see `withWslSharedEnv`). The `WSLENV` set here replaces the session's own for
 * that one process, so anything it should still carry across is named again.
 *
 * Values cross verbatim (no `/p` translation): each is already written the way
 * the Windows side reads it.
 */
export function wslInteropEnv(env: Record<string, string>, shared: readonly string[] = []): Record<string, string> {
  const names = mergeWslEnv(
    undefined,
    [...Object.keys(env), ...shared].filter((name) => name !== 'WSLENV'),
  )
  if (!names) return { ...env }
  return { ...env, WSLENV: names }
}
