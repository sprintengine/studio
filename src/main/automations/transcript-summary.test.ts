import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MAX_TRANSCRIPT_BYTES, MAX_TRANSCRIPT_SUMMARY_LENGTH, readTranscriptSummary } from './transcript-summary'

const workDir = mkdtempSync(join(tmpdir(), 'multicode-transcript-summary-'))

function writeTranscript(name: string, rows: unknown[]): string {
  const filePath = join(workDir, name)
  writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
  return filePath
}

function assistantRow(id: string, text: string, extra: Record<string, unknown> = {}): unknown {
  return { type: 'assistant', message: { id, content: [{ type: 'text', text }] }, ...extra }
}

function userRow(text: string): unknown {
  return { type: 'user', message: { role: 'user', content: text } }
}

async function assertReturnsLastAssistantText(): Promise<void> {
  const filePath = writeTranscript('basic.jsonl', [
    userRow('build the thing'),
    assistantRow('msg_1', 'starting'),
    userRow('and test it'),
    assistantRow('msg_2', 'opened PR #7'),
  ])
  assert.equal(await readTranscriptSummary(filePath), 'opened PR #7')
}

async function assertJoinsBlocksOfTheLastMessageGroup(): Promise<void> {
  // A multi-content-block turn is several rows sharing one message.id: the
  // summary is the whole group, not literally the last row.
  const filePath = writeTranscript('grouped.jsonl', [
    assistantRow('msg_1', 'earlier turn'),
    { type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'first block' }] } },
    { type: 'assistant', message: { id: 'msg_2', content: [{ type: 'tool_use', name: 'Bash' }] } },
    { type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'second block' }] } },
  ])
  assert.equal(await readTranscriptSummary(filePath), 'first block\nsecond block')
}

async function assertIgnoresSidechainRows(): Promise<void> {
  // A Task subagent's final message must never become the run summary.
  const filePath = writeTranscript('sidechain.jsonl', [
    assistantRow('msg_1', 'the real answer'),
    assistantRow('msg_2', 'subagent chatter', { isSidechain: true }),
  ])
  assert.equal(await readTranscriptSummary(filePath), 'the real answer')
}

async function assertAcceptsStringContent(): Promise<void> {
  const filePath = writeTranscript('string-content.jsonl', [
    { type: 'assistant', message: { id: 'msg_1', content: 'plain string turn' } },
  ])
  assert.equal(await readTranscriptSummary(filePath), 'plain string turn')
}

async function assertTruncatesToTheCap(): Promise<void> {
  const filePath = writeTranscript('long.jsonl', [assistantRow('msg_1', 'x'.repeat(5_000))])
  const summary = await readTranscriptSummary(filePath)
  assert.ok(summary)
  assert.equal(summary.length, MAX_TRANSCRIPT_SUMMARY_LENGTH)
  assert.ok(summary.endsWith('…'))
}

async function assertRejectsUntrustedPaths(): Promise<void> {
  // Relative path: never resolved against a cwd.
  assert.equal(await readTranscriptSummary('relative/transcript.jsonl'), undefined)
  assert.equal(await readTranscriptSummary('../../etc/passwd.jsonl'), undefined)
  // Wrong extension: an arbitrary-file read is not a transcript read.
  assert.equal(await readTranscriptSummary(join(workDir, 'secrets.env')), undefined)
  assert.equal(await readTranscriptSummary('/etc/passwd'), undefined)
  // Empty and NUL-bearing paths.
  assert.equal(await readTranscriptSummary(''), undefined)
  assert.equal(await readTranscriptSummary(`${join(workDir, 'basic.jsonl')}\0.jsonl`), undefined)
}

async function assertRejectsUnusableFiles(): Promise<void> {
  // Nonexistent.
  assert.equal(await readTranscriptSummary(join(workDir, 'missing.jsonl')), undefined)
  // A directory named like a transcript: a streaming read of one never resolves.
  const dirPath = join(workDir, 'dir.jsonl')
  mkdirSync(dirPath)
  assert.equal(await readTranscriptSummary(dirPath), undefined)
}

async function assertRejectsOversizeFile(): Promise<void> {
  const filePath = writeTranscript('huge.jsonl', [assistantRow('msg_1', 'would be the summary')])
  // Grow the file past the cap sparsely rather than writing 32MB of bytes.
  await truncate(filePath, MAX_TRANSCRIPT_BYTES + 1)
  assert.equal(await readTranscriptSummary(filePath), undefined)
}

async function assertReturnsUndefinedWithoutAssistantText(): Promise<void> {
  // Malformed JSON lines are skipped by the row reader, never fatal.
  const malformed = join(workDir, 'malformed.jsonl')
  writeFileSync(malformed, '{not json\nalso not json\n', 'utf8')
  assert.equal(await readTranscriptSummary(malformed), undefined)

  // No assistant rows at all.
  assert.equal(await readTranscriptSummary(writeTranscript('user-only.jsonl', [userRow('hello')])), undefined)
  // Assistant rows carrying no text (tool_use only, or whitespace).
  assert.equal(
    await readTranscriptSummary(
      writeTranscript('tool-only.jsonl', [
        { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', name: 'Bash' }] } },
      ]),
    ),
    undefined,
  )
  assert.equal(
    await readTranscriptSummary(writeTranscript('whitespace.jsonl', [assistantRow('msg_1', '  \n ')])),
    undefined,
  )
  // Empty file.
  const empty = join(workDir, 'empty.jsonl')
  writeFileSync(empty, '', 'utf8')
  assert.equal(await readTranscriptSummary(empty), undefined)
}

async function main(): Promise<void> {
  try {
    await assertReturnsLastAssistantText()
    await assertJoinsBlocksOfTheLastMessageGroup()
    await assertIgnoresSidechainRows()
    await assertAcceptsStringContent()
    await assertTruncatesToTheCap()
    await assertRejectsUntrustedPaths()
    await assertRejectsUnusableFiles()
    await assertRejectsOversizeFile()
    await assertReturnsUndefinedWithoutAssistantText()
    console.log('automations transcript-summary tests passed')
  } finally {
    rmSync(workDir, { force: true, recursive: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
