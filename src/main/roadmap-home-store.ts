// The app-level setting that records which project's repo holds the single
// instance roadmap (D1). Stored as a small main-owned JSON file under the app data
// dir — `<userData>/roadmap-home.json` — beside the other main-owned settings
// stores (module-enablement.json etc.), never per-workspace. The creation flow
// (MC-1689) writes it when the roadmap is created; the roadmap surface's overflow
// can re-point it. The orchestrator reads it every reconcile to find the one
// active roadmap; when unset, there is no instance roadmap and reconciliation is a
// no-op.
//
// Reads are synchronous (a single scalar consulted on startup + each reconcile);
// the write is atomic (tmp + rename), mirroring `module-host/enablement-store.ts`.

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROADMAP_HOME_FILE = 'roadmap-home.json'

type RoadmapHomeRecord = { path: string }

function roadmapHomePath(userDataDir: string): string {
  return join(userDataDir, ROADMAP_HOME_FILE)
}

// The configured home project root, or null when unset/malformed. A blank or
// non-string path reads as null so a corrupt file degrades to "no roadmap", never
// to a wrong root.
export function readRoadmapHomeProjectPath(userDataDir: string): string | null {
  const path = roadmapHomePath(userDataDir)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && typeof (parsed as RoadmapHomeRecord).path === 'string') {
      const value = (parsed as RoadmapHomeRecord).path.trim()
      return value.length > 0 ? value : null
    }
  } catch {
    /* malformed → unset */
  }
  return null
}

// Set (or clear, with null) the home project root. Atomic tmp + rename so a
// concurrent read never observes a partial file.
export async function writeRoadmapHomeProjectPath(userDataDir: string, projectRoot: string | null): Promise<void> {
  const path = roadmapHomePath(userDataDir)
  await mkdir(userDataDir, { recursive: true })
  const record: RoadmapHomeRecord = { path: projectRoot?.trim() ?? '' }
  const tmpPath = `${path}.tmp-${process.pid}`
  await writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  try {
    await rename(tmpPath, path)
  } catch (error) {
    await unlink(tmpPath).catch(() => undefined)
    throw error
  }
}
