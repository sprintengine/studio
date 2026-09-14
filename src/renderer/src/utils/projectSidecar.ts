import {
  rememberSidecarDirName,
  sidecarCandidates,
  SIDECAR_DIR_NAME,
} from '../../../shared/workspace-sidecar'

// Which sidecar directory each project uses, answered once per project per
// session and recorded in the shared registry the path builders read.
//
// The main process resolves this by stat'ing; the renderer cannot, so it asks
// the same question over the filesystem bridge, in the same order
// (`sidecarCandidates`). Keyed by folder path and guarded like the project-logo
// detector next door, so every panel that shows the same project shares one
// answer instead of racing its own.
//
// Until an answer lands, the registry reads as the current name. A project that
// still uses the old one therefore has a window at cold start in which a
// renderer-built path names a directory that is not there — a sprint board that
// mounts in that window shows its run as missing and is correct on the next
// render. Nothing is WRITTEN through a renderer-built path without a main-process
// resolve behind it, so the window costs a re-render, not a misplaced file.

const asked = new Set<string>()

/**
 * Resolve a project's sidecar name if it has not been resolved this session.
 * Repeat calls for the same folder are no-ops.
 */
export function ensureProjectSidecarDirName(
  folderPath: string | null | undefined,
  pathExists: (path: string) => Promise<boolean>,
): void {
  if (!folderPath) return
  if (asked.has(folderPath)) return
  asked.add(folderPath)

  void (async () => {
    for (const candidate of sidecarCandidates(folderPath)) {
      let exists = false
      try {
        exists = await pathExists(candidate.root)
      } catch {
        // An unreadable project answers nothing; the default stands and the
        // next session asks again.
        return
      }
      if (exists) {
        rememberSidecarDirName(folderPath, candidate.dirName)
        return
      }
    }
    rememberSidecarDirName(folderPath, SIDECAR_DIR_NAME)
  })()
}

/** Forget every answer. For tests. */
export function resetProjectSidecarDirNames(): void {
  asked.clear()
}
