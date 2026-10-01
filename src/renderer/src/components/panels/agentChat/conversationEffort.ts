// The `chat.effort.cycle` step: the next of the provider's effort levels, then
// back to its own default (undefined) after the last, so the cycle always
// passes through "let the CLI decide".
export function nextConversationEffort(levels: readonly string[], current?: string): string | undefined {
  if (!levels.length) return undefined
  return levels[(levels.indexOf(current ?? '') + 1) % (levels.length + 1)]
}
