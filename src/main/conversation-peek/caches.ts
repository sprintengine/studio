import { clearClaudeTranscriptLocatorCache } from './locate'
import { clearTranscriptPeekCache } from './transcript'

/**
 * Release everything the peek holds between hovers.
 *
 * Both caches are module-level and belong to no session, so nothing in the
 * terminal runtime's teardown would otherwise reach them — and the transcript
 * cache is not small: up to eight parsed transcripts, each of which may retain
 * its first message's images. Called from `shutdownTerminalRuntime`, which is
 * the one moment the process is done with every session at once.
 *
 * Kept in its own module so the shutdown path does not have to import the
 * reader and the locator (and, through the reader, Electron) just to drop them.
 */
export function clearConversationPeekCaches(): void {
  clearTranscriptPeekCache()
  clearClaudeTranscriptLocatorCache()
}
