// Counts what React renders, read off each commit the way a profiler reads it,
// so a suite can hold a count still instead of timing it. Install it before
// `react-dom` is first imported: React looks for the hook once, as it loads.
//
// A component rendered in a commit when its fiber carries the flag React sets
// on a component it called, and the fiber is not one the previous commit left
// in the tree already. React leaves a subtree it skipped in place, flags and
// all, so the flag alone would count a skipped component again.

type Fiber = {
  tag: number
  type: unknown
  elementType: unknown
  flags: number
  child: Fiber | null
  sibling: Fiber | null
}
type FiberRoot = { current: Fiber }

// The component tags: function, class, forwardRef, and a memo over a plain
// function (`React.memo` with a compare renders its inner function as a fiber
// of its own, counted as a function).
const COMPONENT_TAGS = new Set([0, 1, 11, 15])
const PERFORMED_WORK = 1

function nameOf(fiber: Fiber): string {
  const named = (value: unknown): string | undefined => {
    if (!value || (typeof value !== 'function' && typeof value !== 'object')) return undefined
    const record = value as { displayName?: string; name?: string; render?: unknown; type?: unknown }
    return record.displayName || (typeof value === 'function' ? record.name : undefined) || named(record.render)
  }
  return named(fiber.type) ?? named(fiber.elementType) ?? 'Anonymous'
}

export type RenderCounter = {
  /** Commits since the last reset. */
  readonly commits: number
  /** Commits since the last reset in which a component of this name rendered. */
  commitsOf(name: string): number
  /** Renders of components with this name since the last reset. */
  renders(name: string): number
  /** Every component render since the last reset. */
  totalRenders(): number
  /** Renders by component name, most first. */
  table(): [string, number][]
  reset(): void
}

export function installRenderCounter(): RenderCounter {
  const host = globalThis as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }
  let commits = 0
  let renders = new Map<string, number>()
  let commitsByName = new Map<string, number>()
  const seenByRoot = new WeakMap<FiberRoot, WeakSet<Fiber>>()
  host.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject: () => 1,
    checkDCE: () => undefined,
    onScheduleFiberRoot: () => undefined,
    onCommitFiberUnmount: () => undefined,
    onPostCommitFiberRoot: () => undefined,
    onCommitFiberRoot(_rendererId: number, root: FiberRoot) {
      commits++
      const previous = seenByRoot.get(root) ?? new WeakSet<Fiber>()
      const next = new WeakSet<Fiber>()
      const namesThisCommit = new Set<string>()
      const stack: Fiber[] = [root.current]
      while (stack.length) {
        const fiber = stack.pop()!
        next.add(fiber)
        if (COMPONENT_TAGS.has(fiber.tag) && fiber.flags & PERFORMED_WORK && !previous.has(fiber)) {
          const name = nameOf(fiber)
          renders.set(name, (renders.get(name) ?? 0) + 1)
          namesThisCommit.add(name)
        }
        if (fiber.sibling) stack.push(fiber.sibling)
        if (fiber.child) stack.push(fiber.child)
      }
      seenByRoot.set(root, next)
      for (const name of namesThisCommit) commitsByName.set(name, (commitsByName.get(name) ?? 0) + 1)
    },
  }
  return {
    get commits() {
      return commits
    },
    commitsOf: (name) => commitsByName.get(name) ?? 0,
    renders: (name) => renders.get(name) ?? 0,
    totalRenders: () => [...renders.values()].reduce((sum, count) => sum + count, 0),
    table: () => [...renders.entries()].sort((left, right) => right[1] - left[1]),
    reset() {
      commits = 0
      renders = new Map()
      commitsByName = new Map()
    },
  }
}
