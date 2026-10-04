import { access, appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { distroOfUncPath, toWslPath } from '../../shared/host-paths'
import { isMachinePath, parseMachinePath } from '../../shared/machine-paths'
import { sidecarRelativePath } from '../../shared/workspace-sidecar'
import { workspaceSidecarPath } from '../workspace-sidecar'
import type { RecordingFailure, RecordingOutput, RecordingOutputs } from './browser-recorder'
import { withWebmDuration } from './webm-duration'

// Where a browser recording is saved: in the calling agent's workspace, beside
// the pane's screenshots, in `.sprintengine/browser/recordings/`. That folder
// ignores itself (the same `.gitignore` the screenshots write), so a recording
// never shows in `git status`.
//
// The workspace is where the agent is. A workspace on this computer is written
// here directly, and so is one in WSL, through the `\\wsl.localhost\…` path
// this computer opens it by, which is the same folder the agent reads in the
// distribution. The answer names the file relative to the workspace, which
// reads the same on both sides, and as the agent's own machine spells it.
//
// A workspace on an SSH machine is refused before anything is captured.
// Studio has no way yet to write a file into a folder on that machine (its
// server takes reads, and writes of canvas boards only), and a recording kept
// on this computer would be a path the agent there cannot open. The design
// for carrying it there is in docs/design/browser-recording.md.

/** What the pane's capture folder holds; recordings sit in a folder inside it. */
const BROWSER_SIDECAR = 'browser'
const RECORDINGS_FOLDER = 'recordings'
const EXTENSION = '.webm'
/** A file still being written: renamed to its final name when the recording ends. */
const PARTIAL_SUFFIX = '.part'
/** How many names a recording tries before giving up: a folder this full is not one to add to. */
const MAX_NAME_ATTEMPTS = 1_000

// Every check is asynchronous: a WSL workspace is a `\\wsl.localhost\…` share,
// and a synchronous call on it would hold main while the distribution answers.
export type RecordingFs = {
  mkdir(path: string): Promise<void>
  exists(path: string): Promise<boolean>
  writeFile(path: string, data: Uint8Array | string): Promise<void>
  /** Make an empty file, or answer false when one is already there. */
  createNew(path: string): Promise<boolean>
  appendFile(path: string, data: Uint8Array): Promise<void>
  readFile(path: string): Promise<Uint8Array>
  rename(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
  size(path: string): Promise<number>
}

const nodeFs: RecordingFs = {
  mkdir: async (path) => void (await mkdir(path, { recursive: true })),
  exists: (path) =>
    access(path).then(
      () => true,
      () => false,
    ),
  writeFile: (path, data) => writeFile(path, data),
  createNew: (path) =>
    writeFile(path, new Uint8Array(0), { flag: 'wx' }).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') return false
        throw error
      },
    ),
  appendFile: (path, data) => appendFile(path, data),
  readFile: async (path) => new Uint8Array(await readFile(path)),
  rename: (from, to) => rename(from, to),
  remove: (path) => rm(path, { force: true }),
  size: async (path) => (await stat(path)).size,
}

export type WorkspaceRecordingOutputsDeps = {
  /** A workspace's folder from main's registry; null when it has none. */
  resolveWorkspaceRoot(workspaceId: string): string | null
  /** An SSH machine's name for its saved id, for the refusal's wording. */
  machineLabel?(id: string): string | null
  fs?: RecordingFs
}

/** The file as the agent's machine spells it: a WSL distribution reads a `\\wsl…` share's file by its Linux path. */
export function agentPathOf(file: string): string {
  return distroOfUncPath(file) !== null ? toWslPath(file) : file
}

export function createWorkspaceRecordingOutputs(deps: WorkspaceRecordingOutputsDeps): RecordingOutputs {
  const fs = deps.fs ?? nodeFs
  const fail = (code: string, message: string): RecordingFailure => ({ ok: false, code, message })

  return {
    async create({ workspaceId, stem }) {
      const root = deps.resolveWorkspaceRoot(workspaceId)
      if (!root) return fail('no_workspace_folder', 'This workspace has no folder to save a recording in.')
      if (isMachinePath(root)) {
        const machine = parseMachinePath(root)
        const name = (machine && deps.machineLabel?.(machine.id)) || 'an SSH machine'
        return fail(
          'recording_unavailable',
          `Recordings are saved into the workspace, and Studio cannot write files into a workspace on ${name} yet. ` +
            'Recording works for workspaces on this computer and in WSL.',
        )
      }
      if (!isAbsolute(root) || !(await fs.exists(root))) {
        return fail('no_workspace_folder', 'The workspace folder is not available to save a recording in.')
      }

      const browserDir = workspaceSidecarPath(root, BROWSER_SIDECAR)
      const directory = join(browserDir, RECORDINGS_FOLDER)
      let name: string | null = null
      try {
        await fs.mkdir(directory)
        // The folder ignores itself, as it does for the pane's screenshots.
        const ignore = join(browserDir, '.gitignore')
        if (!(await fs.exists(ignore))) await fs.writeFile(ignore, '*\n')
        // A second recording in the same second takes the next free name. The
        // partial file is made exclusively, so two recordings starting
        // together never both take one name.
        for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS && name === null; attempt += 1) {
          const candidate = attempt === 1 ? `${stem}${EXTENSION}` : `${stem}-${attempt}${EXTENSION}`
          if (await fs.exists(join(directory, candidate))) continue
          if (await fs.createNew(join(directory, candidate + PARTIAL_SUFFIX))) name = candidate
        }
      } catch (error) {
        return fail(
          'write_failed',
          `The recording could not be saved: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (name === null) return fail('write_failed', 'The recording could not be saved: no free file name was left.')
      const file = join(directory, name)
      const partial = file + PARTIAL_SUFFIX

      const output: RecordingOutput = {
        workspacePath: sidecarRelativePath(BROWSER_SIDECAR, RECORDINGS_FOLDER, name),
        path: agentPathOf(file),
        append: (bytes) => fs.appendFile(partial, bytes),
        async finish(durationMs) {
          // The length goes into the header; a file this edit does not
          // understand is kept as it is, playable without one.
          const recorded = await fs.readFile(partial)
          const withLength = withWebmDuration(recorded, durationMs)
          if (withLength) {
            await fs.writeFile(file, withLength)
            await fs.remove(partial)
          } else {
            await fs.rename(partial, file)
          }
          return { bytes: await fs.size(file) }
        },
        async discard() {
          await fs.remove(partial)
        },
      }
      return { ok: true, output }
    },
  }
}
