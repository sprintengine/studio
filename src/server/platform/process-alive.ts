/**
 * Whether a process with this pid exists, by sending it signal 0 (which checks
 * the pid without delivering anything).
 *
 * EPERM counts as running: the process exists, it simply belongs to someone
 * else and is not ours to signal. A caller deciding whether a lock or a marker
 * file is stale must not take another user's live process for a dead one.
 * Every other error (ESRCH above all) means nothing runs under that pid.
 *
 * Only a positive integer names one process. `kill(0, 0)` signals this
 * process's group and `kill(-1, 0)` every process the user may signal, so both
 * succeed: a lock or marker file holding 0, a negative number or a fraction
 * would otherwise read as held for ever.
 */
export function processIsRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
