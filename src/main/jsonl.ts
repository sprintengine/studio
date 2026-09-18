import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

// Tolerant streaming-JSONL iteration shared by the transcript readers:
// blank lines and malformed rows (e.g. a truncated trailing write from a live
// CLI) are skipped, never fatal. The reader is always closed.
export async function forEachJsonlRow(filePath: string, onRow: (row: unknown) => void): Promise<void> {
  const reader = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  try {
    for await (const line of reader) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let row: unknown
      try {
        row = JSON.parse(trimmed)
      } catch {
        continue
      }
      onRow(row)
    }
  } finally {
    reader.close()
  }
}
