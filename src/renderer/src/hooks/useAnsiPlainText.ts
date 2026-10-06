import { useMemo, useRef } from 'react'

import { createAnsiPlainTextReader } from '../../../shared/conversation/ansi'

/**
 * A command's streamed output as the words a terminal would leave (no
 * escapes, a progress bar as its last frame), parsed a chunk at a time: a log
 * that grows by a chunk is not read again from its start.
 */
export function useAnsiPlainText(text: string): string {
  const reader = useRef<((text: string) => string) | null>(null)
  return useMemo(() => {
    reader.current ??= createAnsiPlainTextReader()
    return reader.current(text)
  }, [text])
}
