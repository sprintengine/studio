import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createFilesystemReadHandlers,
  looksLikeBinary,
  MAX_IMAGE_DATA_URL_BYTES,
  MAX_TEXT_FILE_READ_BYTES,
} from './filesystem-read'
import { readMemoryPreview } from './memory-graph'

void main()

async function main(): Promise<void> {
  await assertTextReadLimits()
  await assertReportSymlinkContainment()
  await assertImageReadLimits()
  await assertFileStats()
  await assertMemoryPreviewImageLimit()
  assertBinarySniffing()
}

// A committed symlink under reports/ that resolves outside reports/ must be
// blocked at the read boundary (F2): the viewer should see a rejection, not the
// target file's contents. Symlinks that stay within reports/, plain report
// files, and reads outside any reports/ tree are unaffected.
async function assertReportSymlinkContainment(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'multicode-fs-report-symlink-'))
  const handlers = createFilesystemReadHandlers()

  try {
    const reportsDir = join(root, 'reports')
    mkdirSync(reportsDir, { recursive: true })

    const secretPath = join(root, 'secret.txt')
    writeFileSync(secretPath, 'top secret\n', 'utf8')

    const realReportPath = join(reportsDir, 'real.md')
    writeFileSync(realReportPath, '# Real report\n', 'utf8')
    assert.equal(await handlers.readTextFile(realReportPath), '# Real report\n')

    // Escapes reports/ -> blocked, and never returns the secret contents.
    const escapingLink = join(reportsDir, 'leak.md')
    symlinkSync(join('..', 'secret.txt'), escapingLink)
    await assert.rejects(() => handlers.readTextFile(escapingLink), /outside reports\//u)

    // Stays within reports/ -> still readable.
    const containedLink = join(reportsDir, 'alias.md')
    symlinkSync('real.md', containedLink)
    assert.equal(await handlers.readTextFile(containedLink), '# Real report\n')

    // A symlinked DIRECTORY ancestor under reports/ escapes even though the leaf
    // file is a plain (non-symlink) entry, so leaf-only checks miss it: the
    // realpath must collapse the whole chain and block it.
    const outsideDir = join(root, 'outside')
    mkdirSync(outsideDir, { recursive: true })
    writeFileSync(join(outsideDir, 'leak.md'), 'top secret dir\n', 'utf8')
    const escapingDirLink = join(reportsDir, 'subdir')
    symlinkSync(join('..', 'outside'), escapingDirLink)
    await assert.rejects(
      () => handlers.readTextFile(join(escapingDirLink, 'leak.md')),
      /outside reports\//u
    )

    // A symlinked DIRECTORY that stays within reports/ still reads through.
    const innerDir = join(reportsDir, 'inner')
    mkdirSync(innerDir, { recursive: true })
    writeFileSync(join(innerDir, 'nested.md'), '# Nested report\n', 'utf8')
    const containedDirLink = join(reportsDir, 'inner-alias')
    symlinkSync('inner', containedDirLink)
    assert.equal(
      await handlers.readTextFile(join(containedDirLink, 'nested.md')),
      '# Nested report\n'
    )

    // A symlink that escapes but lives outside any reports/ tree is not a report
    // read and keeps its existing behavior (no regression for general reads).
    const nonReportLink = join(root, 'note.md')
    symlinkSync(join('reports', 'real.md'), nonReportLink)
    assert.equal(await handlers.readTextFile(nonReportLink), '# Real report\n')
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
}

async function assertTextReadLimits(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'multicode-fs-read-text-'))
  const handlers = createFilesystemReadHandlers()

  try {
    const smallPath = join(root, 'notes.txt')
    writeFileSync(smallPath, 'hello\n', 'utf8')
    assert.equal(await handlers.readTextFile(smallPath), 'hello\n')

    const largePath = join(root, 'large.txt')
    writeFileSync(largePath, Buffer.alloc(MAX_TEXT_FILE_READ_BYTES + 1, 0x61))
    await assert.rejects(
      () => handlers.readTextFile(largePath),
      /too large/u
    )

    const binaryPath = join(root, 'binary.dat')
    writeFileSync(binaryPath, Buffer.from([0x68, 0x69, 0x00, 0xff]))
    await assert.rejects(
      () => handlers.readTextFile(binaryPath),
      /binary/u
    )
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
}

async function assertImageReadLimits(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'multicode-fs-read-image-'))
  const handlers = createFilesystemReadHandlers()

  try {
    const smallImagePath = join(root, 'image.png')
    writeFileSync(smallImagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const dataUrl = await handlers.readImageDataUrl(smallImagePath)
    assert.match(dataUrl, /^data:image\/png;base64,/u)

    const largeImagePath = join(root, 'large.png')
    writeFileSync(largeImagePath, Buffer.alloc(MAX_IMAGE_DATA_URL_BYTES + 1, 0x89))
    await assert.rejects(
      () => handlers.readImageDataUrl(largeImagePath),
      /too large/u
    )
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
}

async function assertFileStats(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'multicode-fs-stat-'))
  const handlers = createFilesystemReadHandlers()

  try {
    const targetPath = join(root, 'mockup.html')
    writeFileSync(targetPath, '<main>hello</main>', 'utf8')
    const stats = await handlers.statPath(targetPath)
    assert.equal(stats.isFile, true)
    assert.equal(stats.isDirectory, false)
    assert.equal(stats.sizeBytes, '<main>hello</main>'.length)
    assert.match(stats.modifiedAt, /^\d{4}-\d{2}-\d{2}T/u)
    assert.equal(Number.isFinite(stats.modifiedAtMs), true)
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
}

async function assertMemoryPreviewImageLimit(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'multicode-memory-preview-image-'))

  try {
    const knowledgeRoot = join(root, 'knowledge')
    mkdirSync(knowledgeRoot, { recursive: true })
    const largeImagePath = join(knowledgeRoot, 'large.png')
    writeFileSync(largeImagePath, Buffer.alloc(MAX_IMAGE_DATA_URL_BYTES + 1, 0x89))

    const preview = await readMemoryPreview(root, 'knowledge', 'large.png')
    assert.equal(preview.ok, true)
    if (preview.ok) {
      assert.equal(preview.previewKind, 'unsupported')
      assert.match(preview.message, /too large/u)
    }
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
}

function assertBinarySniffing(): void {
  assert.equal(looksLikeBinary(Buffer.from('plain text\n')), false)
  assert.equal(looksLikeBinary(Buffer.from([0x61, 0x00, 0x62])), true)
}
