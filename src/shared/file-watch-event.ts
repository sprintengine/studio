import type { FileWatchEvent } from './ipc/filesystem'

/**
 * The paths a watch event names, or null when it names none a consumer can
 * trust — the OS gave no filename, or the burst overflowed — which every
 * consumer must read as "something here changed, re-read".
 *
 * An event from before paths were batched carries only `path`; it is read as a
 * one-path batch, or as unknown when that path is null.
 */
export function watchEventPaths(event: Pick<FileWatchEvent, 'path' | 'paths' | 'overflow'>): string[] | null {
  if (event.overflow) return null
  if (event.paths && event.paths.length > 0) return event.paths
  return event.path ? [event.path] : null
}

/**
 * Whether a watch event is entirely about paths the consumer ignores. An event
 * naming no paths is never "entirely ignored": dropping it is how a real edit
 * that arrived in a burst used to be lost.
 */
export function isWatchEventIgnored(
  event: Pick<FileWatchEvent, 'path' | 'paths' | 'overflow'>,
  isIgnored: (path: string) => boolean,
): boolean {
  const paths = watchEventPaths(event)
  return paths !== null && paths.every(isIgnored)
}
