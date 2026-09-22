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
