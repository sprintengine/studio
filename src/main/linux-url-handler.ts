import { execFile } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { STUDIO_PRODUCT_NAME } from '../shared/product-identity'
import { writeFileAtomically } from './config-file-write'

// The Linux build is an AppImage, and an AppImage installs nothing: the
// `protocols` the build declares only reach a desktop entry when a separate
// integration tool unpacks one, so on most machines a `sprintengine://` link
// had no app to open it. The app writes that entry itself instead, a hidden one
// that does nothing but answer for the scheme, pointing at the AppImage file
// that is running, and makes it the scheme's default.
//
// At every start, after `ready` and without anyone waiting on it. Nothing is
// written when the entry on disk is already this one, and `xdg-mime` is asked
// again only when it names another file. A machine without the tools, or a
// home that cannot be written, keeps the link prompt it had before, and the
// failure goes to the diagnostics log rather than anywhere the person sees it.
//
// Electron-free: what it touches comes in as `LinuxUrlHandlerDeps`, so a test
// drives it with a stand-in file system and stand-in commands.

/** The key that marks a desktop entry as this app's link handler, so removal never deletes another. */
export const URL_HANDLER_MARKER = 'X-SprintEngine-Handler=true'

/** The entry's file name for a scheme, in the applications directory. */
export function urlHandlerFileName(scheme: string): string {
  return `${scheme}-url-handler.desktop`
}

/** Whether a desktop entry's text is one this app wrote. */
export function isOwnUrlHandlerEntry(text: string): boolean {
  return text.split(/\r?\n/u).some((line) => line.trim() === URL_HANDLER_MARKER)
}

// A desktop entry's string values are unescaped once for the file, then the
// Exec value again by its own quoting rules, so the argument is quoted first
// and string-escaped after: a backslash in the path is four in the file.
const STRING_ESCAPES: Record<string, string> = { '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' }
function escapeString(value: string): string {
  return value.replace(/[\\\n\r\t]/gu, (char) => STRING_ESCAPES[char] ?? char)
}

/**
 * One Exec argument, quoted. Inside the quotes a double quote, backtick, dollar
 * sign or backslash is escaped with a backslash, and a percent sign is doubled
 * so it is not read as a field code like the `%U` after it.
 */
export function escapeExecArgument(value: string): string {
  const quoted = value.replace(/["`$\\]/gu, (char) => `\\${char}`).replace(/%/gu, '%%')
  return escapeString(`"${quoted}"`)
}

export function renderUrlHandlerEntry(scheme: string, appImage: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${STUDIO_PRODUCT_NAME}`,
    `Comment=Opens ${scheme}:// links in ${STUDIO_PRODUCT_NAME}`,
    `Exec=${escapeExecArgument(appImage)} %U`,
    'Terminal=false',
    // Not a second launcher in the applications menu: the AppImage's own entry,
    // when the person has one, is the one they open the app from.
    'NoDisplay=true',
    `MimeType=x-scheme-handler/${scheme};`,
    URL_HANDLER_MARKER,
    '',
  ].join('\n')
}

export type ExecResult = { code: number | null; stdout: string }

export type LinuxUrlHandlerDeps = {
  platform: NodeJS.Platform
  isPackaged: boolean
  env: NodeJS.ProcessEnv
  homeDir: string
  /** Rejects when the file cannot be read, a missing one included. */
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, content: string) => Promise<void>
  /** Creates the directory and its parents; succeeds when it is already there. */
  mkdir: (path: string) => Promise<void>
  /** Runs a program. Rejects when it cannot be started (not installed) or runs too long. */
  exec: (file: string, args: string[]) => Promise<ExecResult>
  log: (level: 'info' | 'warning', message: string, details?: Record<string, unknown>) => void
  /** The entry is on disk and this app's: put it in the integration ledger. */
  record: (path: string, scheme: string) => void
}

/** `$XDG_DATA_HOME/applications`, else `~/.local/share/applications`. A relative XDG path is ignored, as the spec says. */
export function applicationsDir(env: NodeJS.ProcessEnv, homeDir: string): string {
  const dataHome = env.XDG_DATA_HOME
  return join(dataHome && isAbsolute(dataHome) ? dataHome : join(homeDir, '.local', 'share'), 'applications')
}

export async function registerLinuxUrlHandler(deps: LinuxUrlHandlerDeps, schemes: readonly string[]): Promise<void> {
  if (deps.platform !== 'linux' || !deps.isPackaged) return
  // Inside a running AppImage `process.execPath` is a mount under /tmp that is
  // gone when the app quits; APPIMAGE is the file the person launched.
  const appImage = deps.env.APPIMAGE
  if (!appImage || !isAbsolute(appImage)) return
  const dir = applicationsDir(deps.env, deps.homeDir)
  for (const scheme of schemes) {
    try {
      await registerScheme(deps, dir, scheme, appImage)
    } catch (error) {
      deps.log('warning', 'The link handler could not be registered', { scheme, error: message(error) })
    }
  }
}

async function registerScheme(deps: LinuxUrlHandlerDeps, dir: string, scheme: string, appImage: string) {
  const name = urlHandlerFileName(scheme)
  const path = join(dir, name)
  const mimeType = `x-scheme-handler/${scheme}`
  const content = renderUrlHandlerEntry(scheme, appImage)
  const existing = await deps.readFile(path).catch(() => null)
  if (existing === content) {
    deps.record(path, scheme)
    // The entry is current, but another app may have claimed the scheme since.
    const current = await run(deps, 'xdg-mime', ['query', 'default', mimeType])
    if (!current || current.code !== 0 || current.stdout.trim() === name) return
    await run(deps, 'xdg-mime', ['default', name, mimeType])
    return
  }
  // Missing, or written for an AppImage that has since moved or been replaced.
  await deps.mkdir(dir)
  await deps.writeFile(path, content)
  deps.record(path, scheme)
  // Some desktops only take an entry as a scheme's handler once the MIME cache
  // lists it. The cache is a nicety: `xdg-mime` below runs whether or not it
  // could be refreshed.
  await run(deps, 'update-desktop-database', [dir])
  const set = await run(deps, 'xdg-mime', ['default', name, mimeType])
  if (set?.code === 0) deps.log('info', 'Registered the link handler', { scheme, path })
}

/** A command's result, or null when it could not be run. A failure is logged either way, never thrown. */
async function run(deps: LinuxUrlHandlerDeps, file: string, args: string[]): Promise<ExecResult | null> {
  try {
    const result = await deps.exec(file, args)
    if (result.code !== 0) deps.log('warning', `${file} did not succeed`, { args, code: result.code })
    return result
  } catch (error) {
    deps.log('warning', `${file} could not be run`, { args, error: message(error) })
    return null
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Long enough for a desktop database of a few hundred entries; a tool that
// hangs past it is given up on rather than left running behind the app.
const COMMAND_TIMEOUT_MS = 5_000

/** The real file system and commands, for everything but what the caller knows about the app. */
export function systemLinuxUrlHandlerDeps(): Pick<
  LinuxUrlHandlerDeps,
  'homeDir' | 'readFile' | 'writeFile' | 'mkdir' | 'exec'
> {
  return {
    homeDir: homedir(),
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: writeFileAtomically,
    mkdir: async (path) => {
      await mkdir(path, { recursive: true })
    },
    exec: (file, args) =>
      new Promise((resolve, reject) => {
        execFile(file, args, { timeout: COMMAND_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
          if (!error) return resolve({ code: 0, stdout: String(stdout) })
          const code = (error as { code?: unknown }).code
          // A number is the program's exit status; anything else (ENOENT, a
          // timeout's kill) means it did not run to an answer.
          if (typeof code === 'number') resolve({ code, stdout: String(stdout) })
          else reject(error)
        })
      }),
  }
}
