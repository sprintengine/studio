/**
 * Render a Windows path so a Linux shell running under WSL can execute it.
 *
 * The launched process is still a Windows executable, so its script arguments
 * and environment stay in Windows path form. Only the executable named by the
 * Linux shell crosses through `/mnt/<drive>`.
 */
export function toWslInteropExecutable(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const drive = /^([A-Za-z]):\/(.*)$/u.exec(normalized)
  if (!drive) return normalized
  return `/mnt/${drive[1].toLowerCase()}/${drive[2]}`
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
 * Values cross verbatim (no `/p` translation): each is already written the way
 * the Windows side reads it.
 */
export function wslInteropEnv(env: Record<string, string>): Record<string, string> {
  const names = Object.keys(env).filter((name) => name !== 'WSLENV')
  if (names.length === 0) return { ...env }
  return { ...env, WSLENV: names.join(':') }
}
