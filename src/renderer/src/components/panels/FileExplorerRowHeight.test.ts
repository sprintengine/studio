import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The File Explorer's rows at 24px (epic `git-commit-window`, T2). The tree
// sets the shared density, and the Commit window's changes list is
// about to wear the same row, so the tree comes to `sem.size.hit-target-min`
// first.
//
// jsdom loads no stylesheet, so a mounted row would measure 0 here — the class
// string IS the height in a Tailwind app, and it is what this reads, the same
// way `designSystemConformance.test.tsx` reads class lists rather than computed
// boxes. Two rows are held to it: the root row and the entry row.

const SOURCE = readFileSync(join(process.cwd(), 'src/renderer/src/components/panels/FileExplorer.tsx'), 'utf8')

const ROW_CLASS =
  /group flex (min-h-\[[^\]]+\]) cursor-pointer select-none items-center gap-2 rounded-md (px-2) (py-[\d.]+) text-meta/g
const rows = Array.from(SOURCE.matchAll(ROW_CLASS))

assert.equal(rows.length, 2, 'the tree has exactly two row class strings: the root row and the entry row')

// Tailwind's `py-<n>` is n × 4px; `py-0.5` is 2px.
const PADDING_PX: Record<string, number> = { 'py-0': 0, 'py-0.5': 2, 'py-1': 4, 'py-1.5': 6, 'py-2': 8 }

// The tallest thing a row puts in its content box. The chevron is the kit's
// 24px `xs` IconButton pulled back to a 16px advance by `-my-1`; the folder and
// file marks are 16px; the text line box is the 12px `text-meta` at the app's
// 1.5 line-height; the rename field is `h-5`.
const CONTENT_PX = 20

for (const [whole, floor, , padding] of rows) {
  assert.equal(floor, 'min-h-[var(--hit-target-min)]', `the floor is the token, not a literal: ${whole}`)
  const pad = PADDING_PX[padding]
  assert.ok(pad !== undefined, `unrecognised vertical padding ${padding}`)

  // 24px at rest: the floor holds, because the content plus its padding is
  // under it. If padding ever grows back, this row is taller than 24 and the
  // assertion below is what says so.
  const height = Math.max(24, CONTENT_PX + pad * 2)
  assert.equal(height, 24, `a File Explorer row measures ${height}px at rest, not 24px (${whole})`)
}

// The two pixels came out of the padding, never out of the glyph slot: the
// leading marks are still 16px and the chevron still advances 12px, so the tree
// keeps the one glyph column the rest of the app's rails share.
assert.match(SOURCE, /className="-mx-1\.5 -my-1 shrink-0"/, 'the chevron keeps its 12x16 flow advance')
assert.match(SOURCE, /<span className="w-3 shrink-0" \/>/, "a file row's spacer still matches the chevron")

// The rename field replaces the name INSIDE a row, so it has to fit the content
// box the row leaves — otherwise renaming one file pushes every sibling down.
assert.match(SOURCE, /className=\{`h-5 min-w-0 flex-1 px-1\.5 text-meta/, 'the rename field is 20px')

// principles.md asks an indent that aligns to a glyph slot to say what it lines
// up with. The arithmetic is allowed to stay off the space scale; the silence
// is not.
const indent = SOURCE.indexOf('${8 + (depth + 1) * 14}px')
assert.ok(indent > 0, 'the tree still indents by 8 + (depth + 1) * 14')
const preamble = SOURCE.slice(Math.max(0, indent - 900), indent).replace(/\s*\/\/\s*|\s+/g, ' ')
assert.match(preamble, /12px flow advance/, 'the indent says what its step lines up with')

console.log('ok - File Explorer rows measure 24px at rest, on a 16px glyph slot, with the indent explained')
