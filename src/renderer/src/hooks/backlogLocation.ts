import { backlogAbsolutePath, defaultBacklogLocation, type BacklogLocation } from '../../../shared/backlog/scan'
import { joinFilePath } from '../utils/paths'

/**
 * The renderer's view of where a workspace's backlog lives.
 *
 * The main process owns the answer — it reads the config and checks the folder —
 * so this is a cache in front of one IPC call, not a second implementation. It is
 * keyed by workspace folder and held for the life of the window because the root
 * only changes when someone changes it, and `forgetBacklogLocation` is how that
 * change is published.
 *
 * A workspace whose location cannot be resolved (the main process is unreachable,
 * the workspace has gone away) falls back to the default rather than refusing to
 * render: the default is right for every workspace that has not configured a
 * root, which is most of them.
 */
const locations = new Map<string, Promise<BacklogLocation>>()

function cacheKey(folderPath: string): string {
  return folderPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export async function backlogLocationOf(folderPath: string): Promise<BacklogLocation> {
  const key = cacheKey(folderPath)
  const cached = locations.get(key)
  if (cached) return cached

  const pending = (async (): Promise<BacklogLocation> => {
    try {
      const resolved = await window.api.resolveBacklogLocation(folderPath)
      if (resolved.ok) {
        return { workspaceRoot: resolved.location.workspaceRoot, root: resolved.location.root }
      }
    } catch {
      // Fall through to the default below.
    }
    // Only a resolved answer is worth keeping. A failure here is usually
    // transient — the main process still starting, a workspace mid-open — and
    // caching the fallback would pin this workspace to the wrong folder for the
    // life of the window, with no event to correct it.
    locations.delete(key)
    return defaultBacklogLocation(folderPath)
  })()

  locations.set(key, pending)
  return pending
}

/**
 * Drop a cached location. Call after changing a workspace's backlog root so the
 * next scan resolves the new one; call with no argument to drop every entry.
 */
export function forgetBacklogLocation(folderPath?: string): void {
  if (folderPath === undefined) {
    locations.clear()
    return
  }
  locations.delete(cacheKey(folderPath))
}

/**
 * Where a `backlog/<...>` path sits on disk for this workspace, or null if the
 * path is not a backlog path at all. The same containment rule the main process
 * applies, so the renderer cannot probe outside the backlog root either.
 */
export async function backlogFilePath(folderPath: string, relativePath: string): Promise<string | null> {
  return backlogAbsolutePath(await backlogLocationOf(folderPath), relativePath)
}

/**
 * Resolve a path that may be either a backlog path or a plain workspace-relative
 * one. Mockup references are written both ways — `backlog/mockups/x.html` and
 * `mockups/x.html` both occur in the wild — so a backlog path follows the backlog
 * root and everything else stays relative to the checkout, which is what it
 * meant before the root became configurable.
 */
export async function backlogOrWorkspacePath(folderPath: string, relativePath: string): Promise<string> {
  return (await backlogFilePath(folderPath, relativePath)) ?? joinFilePath(folderPath, relativePath)
}

/** The folder a workspace's backlog items are created in. */
export async function backlogRootOf(folderPath: string): Promise<string> {
  return (await backlogLocationOf(folderPath)).root
}

/**
 * Make sure the backlog folder exists, and return it. Idempotent, and it works
 * for a configured root as well as the default one — `ensureDir` takes a parent
 * and a name, so an absolute root is split rather than assumed to sit under the
 * workspace.
 */
export async function ensureBacklogRoot(folderPath: string): Promise<string> {
  const root = await backlogRootOf(folderPath)
  const normalized = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const cut = normalized.lastIndexOf('/')
  if (cut <= 0) return root
  return window.api.ensureDir(normalized.slice(0, cut), normalized.slice(cut + 1))
}
