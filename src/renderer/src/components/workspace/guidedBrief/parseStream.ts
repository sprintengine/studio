export type ConversationTurn = {
  id: string
  speaker: 'spec' | 'user'
  content: string
  createdAt: number
}

// ANSI CSI sequences (color codes, cursor moves, line clears, etc.).
const ANSI_CSI = /\x1b\[[0-9;?]*[a-zA-Z]/g
// ANSI OSC sequences (window title etc.). Terminated by BEL or ST.
const ANSI_OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g
// 2-byte ANSI sequences (charset switches like ESC ( B, ESC = etc.).
const ANSI_TWOBYTE = /\x1b[()=>][\sA-Za-z0-9]/g
// Bare ESC followed by a non-CSI/non-OSC byte.
const ANSI_BARE_ESC = /\x1b./g
// Control characters except CR, LF, and TAB.
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

export function stripAnsiAndOverwrites(text: string): string {
  let result = text.replace(ANSI_CSI, '')
  result = result.replace(ANSI_OSC, '')
  result = result.replace(ANSI_TWOBYTE, '')
  // Any remaining bare ESC sequences are unprintable; drop them along with
  // the byte that followed so the rendered text stays clean.
  result = result.replace(ANSI_BARE_ESC, '')
  result = result.replace(CONTROL_CHARS, '')

  // Carriage returns inside terminal output usually mean "overwrite the
  // current line". Split on LF first, then collapse each line to the
  // text after its last CR so progress spinners and re-drawn status
  // lines do not show their drafts.
  const lines = result.split(/\r?\n/).map((line) => {
    if (!line.includes('\r')) return line
    const parts = line.split('\r')
    return parts[parts.length - 1] ?? ''
  })
  return lines.join('\n')
}

export type AppendChunkInput = {
  chunk: string
  turns: ConversationTurn[]
  now: number
  nextSpecTurnId: () => string
}

/** Pure update: append a fresh agent chunk into the turn list. */
export function appendSpecChunk({
  chunk,
  turns,
  now,
  nextSpecTurnId,
}: AppendChunkInput): ConversationTurn[] {
  const cleaned = stripAnsiAndOverwrites(chunk)
  if (!cleaned) return turns
  const last = turns[turns.length - 1]
  if (last && last.speaker === 'spec') {
    const updated = { ...last, content: last.content + cleaned }
    return [...turns.slice(0, -1), updated]
  }
  return [
    ...turns,
    {
      id: nextSpecTurnId(),
      speaker: 'spec' as const,
      content: cleaned,
      createdAt: now,
    },
  ]
}

export type AppendUserTurnInput = {
  message: string
  turns: ConversationTurn[]
  now: number
  nextUserTurnId: () => string
}

/** Pure update: push a user message as a new turn. */
export function appendUserTurn({
  message,
  turns,
  now,
  nextUserTurnId,
}: AppendUserTurnInput): ConversationTurn[] {
  const trimmed = message.trim()
  if (!trimmed) return turns
  return [
    ...turns,
    {
      id: nextUserTurnId(),
      speaker: 'user' as const,
      content: trimmed,
      createdAt: now,
    },
  ]
}
