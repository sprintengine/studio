// The window's command runner, for a surface that finishes its own work and
// then hands the rest to a command the shell owns (a chat's send-and-new
// opening New chat). The workspace manager registers its `runCommand`; with
// none registered, nothing runs and the caller is told so.

type AppCommandRunner = (commandId: string) => boolean

let runner: AppCommandRunner | null = null

/** Register this window's runner; returns the unregister. */
export function setAppCommandRunner(next: AppCommandRunner): () => void {
  runner = next
  return () => {
    if (runner === next) runner = null
  }
}

/** Run a shell command by id; whether anything ran it. */
export function runAppCommand(commandId: string): boolean {
  return runner?.(commandId) ?? false
}
