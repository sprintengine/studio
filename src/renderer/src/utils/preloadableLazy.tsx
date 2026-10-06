import React from 'react'

/**
 * A code-split component that can be fetched before anything asks to draw it.
 *
 * `React.lazy` alone suspends the first time it renders, even when the chunk is
 * already in memory: its payload only learns the module arrived once its own
 * `then` runs, so the first mount always throws, always commits the Suspense
 * fallback, and React then holds the content back until 300 ms after that
 * fallback appeared — a pause the chunk itself (tens of milliseconds) never
 * asked for. `preload()` fetches the chunk early; a mount that starts after it
 * landed renders the module directly and never suspends, so no fallback is
 * shown and nothing is held.
 *
 * The choice between the module and the lazy stand-in is made once per mount,
 * never between renders: a component whose type changed under it would be
 * unmounted and remounted, losing everything typed into it.
 */
export type PreloadableLazy<P extends object> = {
  readonly Component: React.ComponentType<P>
  preload(): void
}

export function preloadableLazy<P extends object>(
  load: () => Promise<{ default: React.ComponentType<P> }>,
): PreloadableLazy<P> {
  let loaded: React.ComponentType<P> | null = null
  let pending: Promise<{ default: React.ComponentType<P> }> | null = null
  const fetchModule = (): Promise<{ default: React.ComponentType<P> }> =>
    (pending ??= load().then(
      (module) => {
        loaded = module.default
        return module
      },
      (error: unknown) => {
        // A failed fetch is retried by the next caller rather than remembered.
        pending = null
        throw error
      },
    ))
  const Lazy = React.lazy(fetchModule)

  function PreloadableComponent(props: P): React.ReactElement {
    const [Resolved] = React.useState<React.ComponentType<P>>(() => loaded ?? Lazy)
    return <Resolved {...props} />
  }

  return {
    Component: PreloadableComponent,
    preload() {
      // Best effort: a failed preload leaves the lazy path, which reports it.
      fetchModule().catch(() => undefined)
    },
  }
}
