// Which Studio processes are running on this machine, whatever their profile,
// and which profiles have left entries in place.
//
// The quit takes this machine's session integrations back out (hooks and MCP
// entries in repositories, the launcher). Those are shared: a development
// build and the packaged app write the same entries into the same checkouts
// and run the same launcher, and each profile's ledger lists only its own
// writes. So:
//
//  - an instance that quits while another is running leaves its entries in
//    place for that one; they stay in its ledger, and a later quit with nobody
//    else running takes them out;
//  - a profile whose entries are still in place holds the launcher they run:
//    another profile's quit then removes its own entries but not the launcher.
//
// Under `~/.sprintengine/instances`, each running process keeps a file named
// for its pid, touched every minute; one whose process is gone, or which has
// not been touched in a while (the pid now names something else), is pruned by
// the next instance that looks. Each profile holding the launcher keeps a
// `held-<profile>` file until a quit of its own leaves nothing that runs it.

import { mkdir, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { STUDIO_HOME_DIR } from './launcher'

const INSTANCES_DIR = 'instances'
const HELD_PREFIX = 'held-'
const HEARTBEAT_MS = 60_000
// Several missed beats: a machine waking from sleep fires the overdue beat at once.
const STALE_MS = 5 * HEARTBEAT_MS

function instancesDir(home: string): string {
  return join(home, STUDIO_HOME_DIR, INSTANCES_DIR)
}

// Another Studio runs as the same user, so a pid that is not ours to signal
// (EPERM) is some other process that has reused it. That is why this does not
// use `processIsRunning` (server/platform/process-alive), which counts EPERM as
// alive for locks whose holder may belong to someone else.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function writeMarker(dir: string, name: string): Promise<void> {
  // Another instance's quit can remove the empty folder between the two calls.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, name), '')
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || attempt >= 2) throw error
    }
  }
}

let heartbeat: ReturnType<typeof setInterval> | null = null

export async function registerLiveInstance(home: string, pid: number = process.pid): Promise<void> {
  const dir = instancesDir(home)
  await writeMarker(dir, String(pid))
  if (heartbeat) clearInterval(heartbeat)
  heartbeat = setInterval(() => void writeMarker(dir, String(pid)).catch(() => undefined), HEARTBEAT_MS)
  heartbeat.unref()
}

export type LiveInstanceCheck = { alive?: (pid: number) => boolean; now?: number }

/** Whether a Studio process other than `pid` is running; prunes the files of ones that are not. */
export async function otherInstanceRunning(
  home: string,
  pid: number = process.pid,
  { alive = isAlive, now = Date.now() }: LiveInstanceCheck = {},
): Promise<boolean> {
  const dir = instancesDir(home)
  let running = false
  for (const name of (await readdir(dir).catch(() => [])) as string[]) {
    if (name.startsWith(HELD_PREFIX)) continue
    const other = Number(name)
    if (other === pid) continue
    const touched = await stat(join(dir, name)).then(
      (stats) => stats.mtimeMs,
      () => 0,
    )
    if (Number.isInteger(other) && other > 0 && alive(other) && now - touched < STALE_MS) running = true
    else await rm(join(dir, name), { force: true }).catch(() => undefined)
  }
  return running
}

/**
 * Take this process off the list, and say whether another Studio process is
 * still running. The folder goes when this leaves it empty, so the launcher's
 * removal can take `~/.sprintengine` with it.
 */
export async function leaveLiveInstances(
  home: string,
  pid: number = process.pid,
  check: LiveInstanceCheck = {},
): Promise<{ othersRunning: boolean }> {
  if (heartbeat) clearInterval(heartbeat)
  heartbeat = null
  const dir = instancesDir(home)
  await rm(join(dir, String(pid)), { force: true })
  const othersRunning = await otherInstanceRunning(home, pid, check)
  await rmdir(dir).catch(() => undefined)
  return { othersRunning }
}

/** This profile's entries are in place and run the launcher: another profile's quit must leave it. */
export async function holdLauncher(home: string, profile: string): Promise<void> {
  await writeMarker(instancesDir(home), `${HELD_PREFIX}${profile}`)
}

export async function releaseLauncher(home: string, profile: string): Promise<void> {
  const dir = instancesDir(home)
  await rm(join(dir, `${HELD_PREFIX}${profile}`), { force: true })
  await rmdir(dir).catch(() => undefined)
  // The launcher's removal leaves `~/.sprintengine` while this folder is in it;
  // it goes now if that was all, and stays if it holds anything else.
  await rmdir(join(home, STUDIO_HOME_DIR)).catch(() => undefined)
}

/** Whether a profile other than `profile` holds the launcher. */
export async function launcherHeldByOthers(home: string, profile: string): Promise<boolean> {
  const names = (await readdir(instancesDir(home)).catch(() => [])) as string[]
  return names.some((name) => name.startsWith(HELD_PREFIX) && name !== `${HELD_PREFIX}${profile}`)
}
