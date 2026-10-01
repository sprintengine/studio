import { structuredPatch, diffWordsWithSpace } from 'diff'
import { parseUnifiedDiff, type DiffHunk } from '../git/hunks'
import type { ConversationJsonValue } from '../conversation-runtime'

export type ConversationEdit = {
  path: string
  hunks: DiffHunk[]
  added: number
  removed: number
  newFile: boolean
  // A whole-file write whose previous contents the tool did not report: every
  // line reads as added, but the file may well have existed before.
  contentsOnly?: boolean
  limited?: boolean
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** Reconstruct just the recorded hunk context, never today's file contents. */
export function editPreviewSources(edit: ConversationEdit): { original: string; modified: string } {
  return {
    original: edit.hunks
      .map((hunk) =>
        hunk.lines
          .filter((line) => line.startsWith(' ') || line.startsWith('-'))
          .map((line) => line.slice(1))
          .join('\n'),
      )
      .join('\n… omitted unchanged lines …\n'),
    modified: edit.hunks
      .map((hunk) =>
        hunk.lines
          .filter((line) => line.startsWith(' ') || line.startsWith('+'))
          .map((line) => line.slice(1))
          .join('\n'),
      )
      .join('\n… omitted unchanged lines …\n'),
  }
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
function counted(path: string, hunks: DiffHunk[], newFile: boolean): ConversationEdit {
  let added = 0,
    removed = 0
  for (const hunk of hunks)
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  return { path, hunks, added, removed, newFile }
}

/** Hunks are display data only; reverting is always delegated to the checkpoint service. */
export function deriveEditHunks(value: ConversationJsonValue | undefined): ConversationEdit[] {
  const input = record(value)
  const path = text(input.path ?? input.file_path ?? input.filePath)
  if (Array.isArray(input.edits))
    return input.edits.flatMap((edit) =>
      deriveEditHunks({ ...record(edit), path: text(record(edit).path) || path } as ConversationJsonValue),
    )
  if (typeof input.patch === 'string') {
    const patch = input.patch.startsWith('diff --git ') ? input.patch : `diff --git a/${path} b/${path}\n${input.patch}`
    return parseUnifiedDiff(patch).map((file) =>
      counted(file.newPath ?? file.oldPath ?? path, file.hunks, file.oldPath === null && file.newPath !== null),
    )
  }
  const reportsOld = typeof (input.oldText ?? input.old_string) === 'string'
  const oldText = text(input.oldText ?? input.old_string)
  const newText = text(input.newText ?? input.new_string ?? input.content)
  if (!path || (!newText && !oldText)) return []
  // Only an explicitly empty previous version makes this a new file.
  const newFile = reportsOld && !oldText
  const contentsOnly = !reportsOld ? { contentsOnly: true } : {}
  const patch = structuredPatch(path, path, oldText, newText, undefined, undefined, { context: 3, timeout: 50 })
  if (!patch) return [{ path, hunks: [], added: 0, removed: 0, newFile, ...contentsOnly, limited: true }]
  return [{ ...counted(path, patch.hunks, newFile), ...contentsOnly }]
}

export function emphasizeChangedWords(
  oldLine: string,
  newLine: string,
): { old: { text: string; changed: boolean }[]; next: { text: string; changed: boolean }[] } {
  if (oldLine.length > 500 || newLine.length > 500)
    return { old: [{ text: oldLine, changed: false }], next: [{ text: newLine, changed: false }] }
  const changes = diffWordsWithSpace(oldLine, newLine)
  return {
    old: changes.filter((change) => !change.added).map((change) => ({ text: change.value, changed: change.removed })),
    next: changes.filter((change) => !change.removed).map((change) => ({ text: change.value, changed: change.added })),
  }
}

/**
 * Which removed and added lines of a hunk are two versions of one line, for
 * word emphasis: in a run of removals followed by a run of additions, the
 * n-th removal pairs with the n-th addition. Maps each paired index to its
 * partner's.
 */
export function pairReplacedLines(lines: readonly string[]): Map<number, number> {
  const pairs = new Map<number, number>()
  let index = 0
  while (index < lines.length) {
    if (!lines[index].startsWith('-')) {
      index++
      continue
    }
    const removedStart = index
    while (index < lines.length && lines[index].startsWith('-')) index++
    const addedStart = index
    while (index < lines.length && lines[index].startsWith('+')) index++
    const count = Math.min(addedStart - removedStart, index - addedStart)
    for (let offset = 0; offset < count; offset++) {
      pairs.set(removedStart + offset, addedStart + offset)
      pairs.set(addedStart + offset, removedStart + offset)
    }
  }
  return pairs
}
