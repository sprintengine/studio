#!/usr/bin/env node
// Knowledge-graph note-size guard.
//
// Purpose: agents traverse the KG from the README index by following the
// smallest relevant links. One oversized note wastes context for every reader,
// so this guard keeps notes small and flags any that have grown into manuals
// covering more than one concept.
//
// Why words, not lines: line counts are gameable — a note can be "shrunk" from
// 1500 to 200 lines just by rewrapping ~80-char bullets onto single long
// physical lines, without removing a word. Words track tokens (~1 word ≈ 1.3
// tokens), which is the real context cost. Lines stay as a secondary backstop
// only.
//
// Thresholds (configurable via env):
//   SOFT  =   750 words / 140 lines  -> warn (a note getting large)
//   HARD  = 1,500 words / 250 lines  -> fail (split this note into sub-notes)
//
// Ratchet policy: these ceilings were tightened after the 2026-07 full-graph
// prune (101k words -> small linked notes). Never re-raise them; a note that
// wants more room covers more than one concept and should be split.
//
// Usage:
//   node scripts/lint-knowledge-size.mjs            # fail (exit 1) on any HARD breach
//   node scripts/lint-knowledge-size.mjs --report   # never fail; full report
//   node scripts/lint-knowledge-size.mjs path/to/kg # scan a different KG root
//   KNOWLEDGE_ROOT=kg node scripts/lint-knowledge-size.mjs
//
// Exit codes: 0 clean, 1 HARD breach (unless --report), 2 no markdown found
// (CI safety so misconfiguration is visible rather than silently passing).

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'

const SOFT_WORDS = Number(process.env.KG_SIZE_SOFT_WORDS ?? 750)
const SOFT_LINES = Number(process.env.KG_SIZE_SOFT_LINES ?? 140)
const HARD_WORDS = Number(process.env.KG_SIZE_HARD_WORDS ?? 1500)
const HARD_LINES = Number(process.env.KG_SIZE_HARD_LINES ?? 250)

const args = process.argv.slice(2)
const REPORT_ONLY = args.includes('--report')
const positional = args.filter((a) => !a.startsWith('-'))
const KG_ROOT =
  positional[0] ?? process.env.KNOWLEDGE_ROOT ?? process.env.MULTICODE_KNOWLEDGE_ROOT ?? 'knowledge'

function walkMarkdown(absRoot, repoRoot) {
  const out = []
  if (!existsSync(absRoot)) return out
  for (const entry of readdirSync(absRoot, { withFileTypes: true })) {
    const full = join(absRoot, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkMarkdown(full, repoRoot))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full.slice(repoRoot.length + 1).split(sep).join('/'))
    }
  }
  return out
}

const repoRoot = process.cwd()
const kgAbs = resolve(repoRoot, KG_ROOT)
const files = walkMarkdown(kgAbs, repoRoot).sort()

if (files.length === 0) {
  process.stdout.write(
    `\nNo markdown files found under ${KG_ROOT}. Run from the repo root or pass ` +
      'the knowledge root as the first argument / KNOWLEDGE_ROOT env var.\n',
  )
  process.exit(2)
}

const findings = []
let hardBreaches = 0
let softWarnings = 0
let totalWords = 0

for (const rel of files) {
  const source = readFileSync(resolve(repoRoot, rel), 'utf8')
  const lines = source.split('\n').length
  const words = source.trim().length ? source.trim().split(/\s+/).length : 0
  totalWords += words

  const hard = words > HARD_WORDS || lines > HARD_LINES
  const soft = !hard && (words > SOFT_WORDS || lines > SOFT_LINES)
  if (hard) hardBreaches += 1
  if (soft) softWarnings += 1
  if (hard || soft) findings.push({ rel, words, lines, hard, soft })
}

findings.sort((a, b) => b.words - a.words)

process.stdout.write('\nKnowledge note-size guard\n')
process.stdout.write(
  `  scope: ${KG_ROOT} (${files.length} notes, ${totalWords.toLocaleString()} words total)\n`,
)
process.stdout.write(
  `  limits: soft ${SOFT_WORDS}w/${SOFT_LINES}L (warn) · hard ${HARD_WORDS}w/${HARD_LINES}L (fail)\n\n`,
)

if (findings.length === 0) {
  process.stdout.write('  All notes within size limits.\n')
} else {
  process.stdout.write('  WORDS   LINES  NOTE\n')
  for (const f of findings) {
    const tag = f.hard ? 'FAIL' : 'warn'
    process.stdout.write(
      `  ${String(f.words).padStart(6)}  ${String(f.lines).padStart(5)}  [${tag}] ${f.rel}\n`,
    )
  }
  process.stdout.write(
    `\n  ${hardBreaches} over hard cap (split these into sub-notes), ${softWarnings} over soft target.\n`,
  )
  if (hardBreaches > 0) {
    process.stdout.write(
      '  A note over the hard cap covers more than one durable concept; split it into\n' +
        '  linked sub-notes (see the multiauth/ or multivoice-tauri/ pattern) and link\n' +
        '  the new notes from the README index.\n',
    )
  }
}

const exitCode = !REPORT_ONLY && hardBreaches > 0 ? 1 : 0
process.exit(exitCode)
