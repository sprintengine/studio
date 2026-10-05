import { comparablePath } from '../shared/host-paths'

/**
 * One `worktree add`, `remove` or `prune` per repository at a time, within this
 * process.
 *
 * Git serializes the writes to any one file itself, but the worktree registry
 * is a directory of them (`.git/worktrees/<name>/…`), and a `prune` that runs
 * while an `add` is between creating the entry and checking out the tree can
 * see a half-made worktree as stale. The pool adds and removes slots in the
 * background while a person may be creating or removing a worktree in the
 * Worktree manager, so every registry change here queues behind the one before.
 */
const chains = new Map<string, Promise<unknown>>()

export function withWorktreeRegistryLock<T>(repoRoot: string, work: () => Promise<T>): Promise<T> {
  const key = comparablePath(repoRoot)
  const previous = chains.get(key) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(work)
  const tail = run.catch(() => {})
  chains.set(key, tail)
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key)
  })
  return run
}
