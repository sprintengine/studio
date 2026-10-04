import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
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

export type RecordingFs = {
  mkdir(path: string): Promise<void>
  exists(path: string): boolean
  writeFile(path: string, data: Uint8Array | string): Promise<void>
  appendFile(path: string, data: Uint8Array): Promise<void>
  readFile(path: string): Promise<Uint8Array>
  rename(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
  size(path: string): Promise<number>
}

const nodeFs: RecordingFs = {
  mkdir: async (path) => void (await mkdir(path, { recursive: true })),
  exists: (path) => existsSync(path),
  writeFile: (path, data) => writeFile(path, data),
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
      if (!isAbsolute(root) || !fs.exists(root)) {
        return fail('no_workspace_folder', 'The workspace folder is not available to save a recording in.')
      }

      const browserDir = workspaceSidecarPath(root, BROWSER_SIDECAR)
      const directory = join(browserDir, RECORDINGS_FOLDER)
      // A second recording in the same second takes the next free name.
      let name = `${stem}${EXTENSION}`
      for (let suffix = 2; fs.exists(join(directory, name)) || fs.exists(join(directory, name + PARTIAL_SUFFIX));) {
        name = `${stem}-${suffix}${EXTENSION}`
        suffix += 1
      }
      const file = join(directory, name)
      const partial = file + PARTIAL_SUFFIX
      try {
        await fs.mkdir(directory)
        // The folder ignores itself, as it does for the pane's screenshots.
        const ignore = join(browserDir, '.gitignore')
        if (!fs.exists(ignore)) await fs.writeFile(ignore, '*\n')
        await fs.writeFile(partial, new Uint8Array(0))
      } catch (error) {
        return fail(
          'write_failed',
          `The recording could not be saved: ${error instanceof Error ? error.message : String(error)}`,
        )
      }

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
