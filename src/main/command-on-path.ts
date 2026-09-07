// Is this command something this machine can actually run?
//
// One spelling, because two surfaces ask it and they must agree: the MCP config
// service, which turns "command was not found" into a validation issue every
// time it syncs, and the plugin install, which says the same thing on the row
// the moment a plugin lands
// (backlog/2026-09-06-a-plugins-own-files-must-land-before-its-server-can-start.md).
//
// It answers about PATH as this process sees it. That is the honest scope: a
// login shell may have more, and a person who installs `bun` after the app
// started will not be seen until the app restarts — which is why this is a
// warning beside a completed install, never a refusal.

import { existsSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

/** True when `command` is an absolute file that exists, or a name on PATH. */
export function commandOnPath(command: string): boolean {
  const trimmed = command.trim()
  if (trimmed === '') return false
  if (isAbsolute(trimmed)) return existsSync(trimmed)
  const pathValue = process.env.PATH ?? process.env.Path ?? ''
  const names =
    process.platform === 'win32'
      ? [trimmed, `${trimmed}.cmd`, `${trimmed}.exe`, `${trimmed}.ps1`]
      : [trimmed]
  return pathValue.split(delimiter).some((dir) => names.some((name) => existsSync(join(dir, name))))
}
