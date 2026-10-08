/**
 * Whether a process with this pid exists, by sending it signal 0 (which checks
 * the pid without delivering anything).
 *
 * EPERM counts as running: the process exists, it simply belongs to someone
 * else and is not ours to signal. A caller deciding whether a lock or a marker
 * file is stale must not take another user's live process for a dead one.
 * Every other error (ESRCH above all) means nothing runs under that pid.
 */
export function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
