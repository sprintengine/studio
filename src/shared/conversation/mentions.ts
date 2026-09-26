export type ConversationMentionRef = { path: string; kind: 'file' | 'folder'; line?: number; endLine?: number }
export const MAX_CONVERSATION_MENTIONS = 50
export function parseConversationMentions(value: unknown): ConversationMentionRef[] | null {
  if (!Array.isArray(value) || value.length > MAX_CONVERSATION_MENTIONS) return null
  const refs: ConversationMentionRef[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') return null
    const raw = candidate as Record<string, unknown>
    if (
      typeof raw.path !== 'string' ||
      !raw.path ||
      raw.path.length > 4096 ||
      /[\u0000-\u001f]/u.test(raw.path) ||
      !['file', 'folder'].includes(String(raw.kind))
    )
      return null
    if (raw.line !== undefined && (typeof raw.line !== 'number' || !Number.isSafeInteger(raw.line) || raw.line < 1))
      return null
    if (
      raw.endLine !== undefined &&
      (typeof raw.endLine !== 'number' || !Number.isSafeInteger(raw.endLine) || raw.endLine < Number(raw.line ?? 1))
    )
      return null
    refs.push({
      path: raw.path,
      kind: raw.kind as 'file' | 'folder',
      ...(raw.line === undefined ? {} : { line: raw.line as number }),
      ...(raw.endLine === undefined ? {} : { endLine: raw.endLine as number }),
    })
  }
  return refs
}
