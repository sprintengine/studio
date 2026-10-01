import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { isRecord } from '../../shared/records'
import { TOUR_SCHEMA_VERSION, type Tour } from '../../shared/tours/tour-types'
import { writeFileAtomically } from '../config-file-write'

// Tours on disk: one JSON file per tour, under the app's own data folder and
// never in the repository (owner decision: private for now). Grouped per
// workspace so "recent tours" is one directory read.
//
//   <userData>/tours/<workspace hash>/<tourId>.json
//
// The workspace id is hashed into the folder name rather than used as-is: it
// is an id the renderer and the gateway both hand us, and a folder name built
// from it must not be able to walk anywhere.

/** How many tours "recent" means. Older ones stay on disk and stay readable by id. */
export const RECENT_TOURS_LIMIT = 20

const TOUR_ID = /^[a-z0-9-]{6,64}$/

export type TourStore = {
  save(tour: Tour): Promise<void>
  load(workspaceId: string, tourId: string): Promise<Tour | null>
  list(workspaceId: string): Promise<Tour[]>
}

function workspaceDir(root: string, workspaceId: string): string {
  return join(root, createHash('sha1').update(workspaceId).digest('hex').slice(0, 16))
}

/** A parsed file, or null for anything that is not a tour this build can read. */
export function readStoredTour(raw: unknown): Tour | null {
  if (!isRecord(raw)) return null
  if (raw.schemaVersion !== TOUR_SCHEMA_VERSION) return null
  if (typeof raw.id !== 'string' || !TOUR_ID.test(raw.id)) return null
  if (typeof raw.workspaceId !== 'string' || typeof raw.repoRoot !== 'string') return null
  if (typeof raw.title !== 'string' || !Array.isArray(raw.steps)) return null
  if (!isRecord(raw.revisions) || !isRecord(raw.changes) || !isRecord(raw.playback)) return null
  const tour = raw as unknown as Tour
  return {
    ...tour,
    asks: Array.isArray(tour.asks) ? tour.asks : [],
    pointer: tour.pointer ?? null,
    closed: tour.closed === true,
    playback: {
      started: tour.playback.started === true,
      currentStepId: typeof tour.playback.currentStepId === 'string' ? tour.playback.currentStepId : null,
      visited: Array.isArray(tour.playback.visited) ? tour.playback.visited.filter((id) => typeof id === 'string') : [],
      follow: tour.playback.follow === true,
    },
  }
}

export function createTourStore(rootDir: string): TourStore {
  // One write at a time per tour: a playback report and an agent's update can
  // land in the same tick, and the later one must not be overtaken by the older.
  const chains = new Map<string, Promise<void>>()

  return {
    async save(tour) {
      const dir = workspaceDir(rootDir, tour.workspaceId)
      const path = join(dir, `${tour.id}.json`)
      const content = `${JSON.stringify(tour, null, 2)}\n`
      const previous = chains.get(path) ?? Promise.resolve()
      const next = previous
        .catch(() => undefined)
        .then(async () => {
          await mkdir(dir, { recursive: true })
          await writeFileAtomically(path, content)
        })
      chains.set(path, next)
      try {
        await next
      } finally {
        if (chains.get(path) === next) chains.delete(path)
      }
    },

    async load(workspaceId, tourId) {
      if (!TOUR_ID.test(tourId)) return null
      try {
        const text = await readFile(join(workspaceDir(rootDir, workspaceId), `${tourId}.json`), 'utf8')
        const tour = readStoredTour(JSON.parse(text))
        return tour && tour.workspaceId === workspaceId ? tour : null
      } catch {
        return null
      }
    },

    async list(workspaceId) {
      const dir = workspaceDir(rootDir, workspaceId)
      let names: string[]
      try {
        names = (await readdir(dir)).filter((name) => name.endsWith('.json'))
      } catch {
        return []
      }
      const tours: Tour[] = []
      for (const name of names) {
        try {
          const tour = readStoredTour(JSON.parse(await readFile(join(dir, name), 'utf8')))
          if (tour && tour.workspaceId === workspaceId) tours.push(tour)
        } catch {
          // A torn or foreign file is skipped, not fatal to the list.
        }
      }
      return tours.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RECENT_TOURS_LIMIT)
    },
  }
}
