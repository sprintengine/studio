#!/usr/bin/env node
// Mutation test for the design-system conformance guard (T28).
//
// `npm run lint` going green proves the guard found nothing. It does not prove
// the guard would find anything. This script proves the second thing: it feeds
// the guard a tree it MUST reject, one defect at a time, and fails if the guard
// stays quiet.
//
// It exists because the gap it closes already cost a round trip once. Four
// findings were filed against the guard, written up as "must be re-checked after
// the rewrite lands". Nothing re-checked them; all four were still live at
// sign-off and had to be closed a second time. Every probe below is one of
// those findings, expressed as a defect the guard has to catch — so the next
// person to widen a rule re-runs this instead of re-deriving it.
//
//   P1  F1   an alias pointing at the WRONG bundle token. The rule polices a
//            51-entry name-for-name mapping; before T27 it accepted any
//            `--sem-*` alias, so the one error the mapping can actually have was
//            invisible.
//   P2  F2   a mapped name declared in a third, bare `:root` block. T14 measured
//            that a literal there wins the cascade for 18 of the 19 themes; the
//            rule scanned only the base and light blocks.
//   P3  F6a  `--shadow-modal` restated as a literal. It was aliased in
//            `index.css` but missing from `APP_TO_BUNDLE`, so restating it was
//            unguarded.
//   P4  F6b  the micro type floor, moved in `tokens.tokens.json` alone. The
//            floor used to be a hand-copied `10` sitting beside
//            `--sem-font-size-micro: 10px` with nothing keeping the two in sync
//            — the drift this epic exists to end. Moving the token must move
//            what the guard enforces, with no edit to the guard.
//   P5  F6b  the marketing radius floor, which is NOT derived: it is a literal
//            16 that the guard cross-checks against the bundle's largest
//            `sem.radius.*`. Pushing a radius step to 16px or over must make the
//            guard refuse to run (exit 2) rather than silently disagree with the
//            bundle it is supposed to enforce.
//
// P6 and P7 probe the OTHER half of the design-system gate — the raw-primitive
// ratchet in `scripts/lint-primitive-duplication.mjs`, which is the rule that
// answers "what stops a new raw UI element?". A rule whose whole job is to
// refuse something new is worthless if nobody ever checks that it still
// refuses, and it is the newest rule in the family:
//
//   P6       a raw `<button>` in a tree the ratchet has no number for must fail
//            the guard. This is the gate's headline claim, stated as a defect.
//   P7       `--update-baseline` must REFUSE (exit 2) while that button is
//            there. The baseline drains; it never records a new element. An
//            updater that would just write the bigger number turns the ratchet
//            into a formality.
//
// Every probe runs against an isolated copy of the tree in a temp directory. The
// guard resolves every path it reads from `process.cwd()`, so a directory
// holding `scripts/`, `design-system/foundations/`, `index.css` and one `.tsx`
// is a complete harness — and the shared worktree is never mutated, which
// matters because sibling agents are editing it concurrently. Each probe is
// applied to a pristine copy and reverted before the next, so probes cannot mask
// each other.
//
// Usage:  node scripts/testing/design-system-guard-probes.mjs
// Exit 0 when every probe behaved as specified; 1 otherwise.

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(new URL('../..', import.meta.url).pathname)

const GUARD = 'scripts/lint-design-system-conformance.mjs'
const PRIMITIVE_GUARD = 'scripts/lint-primitive-duplication.mjs'
const RAW_PRIMITIVE_BASELINE = 'scripts/design-system-conformance/raw-primitives.json'
const APP_CSS = 'src/renderer/src/assets/index.css'
const TOKENS_JSON = 'design-system/foundations/tokens.tokens.json'
const BUNDLE_CSS = 'design-system/foundations/tokens.css'
// Optional: absent means zero tolerance, which is where the rewrite left it.
const BASELINE = 'scripts/design-system-conformance/disabled-contrast.json'

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (detail) console.log(`        ${detail}`)
}

/* ------------------------------------------------------------------ *
 * The isolated tree
 * ------------------------------------------------------------------ */

function buildHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'ds-guard-probes-'))
  for (const rel of [GUARD, PRIMITIVE_GUARD, APP_CSS, TOKENS_JSON, BUNDLE_CSS, BASELINE]) {
    const from = join(root, rel)
    let content
    try {
      content = readFileSync(from)
    } catch {
      // Only the baseline is allowed to be absent.
      if (rel === BASELINE) continue
      throw new Error(`harness cannot be built: ${rel} is missing from the tree`)
    }
    const to = join(dir, rel)
    mkdirSync(dirname(to), { recursive: true })
    writeFileSync(to, content)
  }
  // The raw-primitive ratchet refuses to run without a baseline (a missing file
  // would mean every raw element in the tree passes unseen, which is the state
  // the rule exists to end). The harness tree has no raw elements, so its
  // baseline is empty — which is also the shape the real one is draining toward.
  mkdirSync(join(dir, 'scripts/design-system-conformance'), { recursive: true })
  writeFileSync(join(dir, RAW_PRIMITIVE_BASELINE), '{\n  "counts": {}\n}\n')
  // The component rules need a source tree to walk. One file whose type sits
  // ABOVE the shipped micro floor and BELOW a moved one: clean today, and the
  // thing P4 makes fire without touching the guard.
  mkdirSync(join(dir, 'src/renderer/src'), { recursive: true })
  writeFileSync(
    join(dir, 'src/renderer/src/GuardProbeFixture.tsx'),
    'export function GuardProbeFixture() {\n' +
      '  return <span className="text-[12px]">a label two pixels above the micro floor</span>\n' +
      '}\n',
  )
  return dir
}

function runGuard(dir) {
  const out = spawnSync(process.execPath, [GUARD], { cwd: dir, encoding: 'utf8' })
  const text = `${out.stdout || ''}${out.stderr || ''}`
  return {
    code: out.status,
    text,
    // `  55:1  rule-name  message`
    violations: text
      .split('\n')
      .map((line) => line.match(/^\s+(\d+):(\d+)\s+([\w-]+)\s+(.*)$/))
      .filter(Boolean)
      .map((m) => ({ line: Number(m[1]), rule: m[3], message: m[4].trim() })),
  }
}

function runPrimitiveGuard(dir, extraArgs = []) {
  const out = spawnSync(process.execPath, [PRIMITIVE_GUARD, ...extraArgs], {
    cwd: dir,
    encoding: 'utf8',
  })
  return { code: out.status, text: `${out.stdout || ''}${out.stderr || ''}` }
}

const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8')
const write = (dir, rel, text) => writeFileSync(join(dir, rel), text)

/* ------------------------------------------------------------------ *
 * Probes
 * ------------------------------------------------------------------ */

// Each probe mutates the pristine text and says what the guard owes it.
const probes = [
  {
    id: 'P1',
    finding: 'F1',
    name: 'a mapped variable aliasing the WRONG bundle token is a violation',
    file: APP_CSS,
    // `--bg-hover` deliberately, not `--bg-app`: an ink-ramp variable makes
    // `theme-ramp-contrast` fire on the contrast fallout, and the probe then
    // "passes" on a violation from the wrong rule. This one is outside the ramp,
    // so only the mapping rule can speak.
    // Scoped to the base block: the light block aliases the same name, so an
    // unscoped replace is ambiguous and mutating both would test two things.
    mutate: (css) =>
      replaceInBaseBlock(
        css,
        '  --bg-hover: var(--sem-color-bg-hover);',
        '  --bg-hover: var(--sem-color-bg-surface-raised);',
      ),
    expect: { rule: 'app-token-restates-bundle', message: /aliases --sem-color-bg-surface-raised.*counterpart is --sem-color-bg-hover/ },
  },
  {
    id: 'P2',
    finding: 'F2',
    name: 'a mapped name declared in a third, bare `:root` block is a violation',
    file: APP_CSS,
    mutate: (css) =>
      `${css}\n:root {\n  --accent-primary: #3f9468;\n  --bg-hover: #18181c;\n  --border-strong: rgba(252, 252, 252, 0.12);\n}\n`,
    // All three, not just the first: the rule has to scan the block, not trip
    // over its opening line.
    expect: { rule: 'app-token-restates-bundle', count: 3, message: /only the base dark and light blocks may carry a mapped name/ },
  },
  {
    id: 'P3',
    finding: 'F6a',
    name: '`--shadow-modal` restated as a literal is a violation',
    file: APP_CSS,
    mutate: (css, dir) => {
      // Take the literal from the bundle rather than hardcoding it here, so this
      // probe cannot drift from the value it is meant to restate. It must be the
      // DARK value: `--shadow-modal` is aliased in the base (dark) block, and
      // restating the light one there is a *drift*, which is a different message
      // from a different half of the rule.
      const value = bundleValueInDarkBlock(read(dir, BUNDLE_CSS), '--sem-shadow-modal')
      return replaceInBaseBlock(
        css,
        '  --shadow-modal: var(--sem-shadow-modal);',
        `  --shadow-modal: ${value};`,
      )
    },
    expect: { rule: 'app-token-restates-bundle', message: /--shadow-modal restates --sem-shadow-modal/ },
  },
  {
    id: 'P4',
    finding: 'F6b',
    name: 'the micro type floor follows `sem.font.size.micro`, with no edit to the guard',
    file: TOKENS_JSON,
    // 13px: above the fixture's 12px, so the fixture goes from clean to
    // violating on the token change alone. A guard carrying its own hardcoded
    // 10 stays silent here — which is exactly the drift being tested for.
    mutate: (json) => setTokenValue(json, ['sem', 'font', 'size', 'micro'], '13px'),
    expect: { rule: 'micro-type-floor', message: /text-\[12px\]/ },
  },
  {
    id: 'P5',
    finding: 'F6b',
    name: 'a bundle radius at or above the marketing floor stops the guard rather than being ignored',
    file: TOKENS_JSON,
    mutate: (json) => {
      const parsed = JSON.parse(json)
      // `pill` is excluded for the same reason the guard excludes it: 999px
      // fully-rounded ends are an IDIOM, not a rung of the shape ramp, and the
      // token says so itself (`doNotUse`: "a tool reading sem.radius.* as a ramp
      // must exclude it"). Mutating it proves nothing — the guard never reads
      // it, so the probe passed a 20px pill through and called the silence a
      // failure of the guard. It went stale exactly this way: `pill` was added
      // to the bundle AFTER this probe was written, and being the last key it
      // quietly became the thing the probe mutated.
      const steps = Object.keys(parsed?.sem?.radius ?? {}).filter(
        (k) => !k.startsWith('$') && k !== 'pill',
      )
      if (!steps.length) throw new Error('the bundle declares no sem.radius.* ramp steps')
      // The ramp step the guard's `largestRadiusPx` actually reads: the biggest
      // one. Pushing a smaller step to 20px would also trip the assertion, but
      // through a number the guard would not otherwise be looking at.
      const largest = steps.reduce((a, b) => {
        const px = (k) => Number.parseFloat(parsed.sem.radius[k]?.$value ?? '0') || 0
        return px(b) > px(a) ? b : a
      })
      return setTokenValue(json, ['sem', 'radius', largest], '20px')
    },
    // Not a violation — a refusal. The floor is a literal 16 the guard asserts
    // against the bundle, so the honest failure is "revisit the rule", exit 2.
    expectExit: 2,
    expect: { message: /declares a 20px radius, at or above the 16px marketing floor/ },
  },
]

// The base block is the first `:root`-family block in `index.css` and runs until
// the light block opens. Both blocks alias the same names, so every probe that
// targets "the base block" has to say so — an unscoped replace either hits the
// wrong block or is ambiguous, and both make the probe prove something other
// than what it claims.
const LIGHT_BLOCK_OPENS = ':root[data-theme="light"]'

function replaceInBaseBlock(css, from, to) {
  const lightAt = css.indexOf(LIGHT_BLOCK_OPENS)
  if (lightAt === -1) throw new Error(`cannot locate the light block (\`${LIGHT_BLOCK_OPENS}\`)`)
  const base = css.slice(0, lightAt)
  const at = base.indexOf(from)
  if (at === -1) {
    throw new Error(`probe anchor not found in the base block, so the probe would be a no-op:\n  ${from}`)
  }
  if (base.indexOf(from, at + from.length) !== -1) {
    throw new Error(`probe anchor is ambiguous within the base block:\n  ${from}`)
  }
  return css.slice(0, at) + to + css.slice(at + from.length)
}

// The bundle declares each token twice: once in `:root` (light) and once in
// `[data-mode="dark"]`. Slice the dark block out by brace rather than matching
// across the file — a lazy match from the selector reaches the light
// declaration whenever the selector text appears anywhere earlier, which is how
// this probe first read the wrong value.
function bundleValueInDarkBlock(bundleCss, token) {
  const open = bundleCss.search(/^\[data-mode="dark"\]\s*\{/m)
  if (open === -1) throw new Error('the bundle declares no [data-mode="dark"] block')
  const close = bundleCss.indexOf('\n}', open)
  const block = bundleCss.slice(open, close === -1 ? undefined : close)
  const found = block.match(new RegExp(`${token}:\\s*([^;]+);`))
  if (!found) throw new Error(`the bundle's dark block declares no ${token}`)
  return found[1].trim()
}

// Edit the DTCG `$value` in place. Re-serialising the whole document would
// rewrite formatting the guard has to parse, and a probe that changes two things
// proves neither.
function setTokenValue(json, path, next) {
  const parsed = JSON.parse(json)
  let node = parsed
  for (const key of path) node = node?.[key]
  const current = node?.$value
  if (typeof current !== 'string') throw new Error(`${path.join('.')} declares no string $value`)
  const escaped = path[path.length - 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `("${escaped}"\\s*:\\s*\\{[^}]*?"\\$value"\\s*:\\s*")${current.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(")`,
  )
  if (!pattern.test(json)) throw new Error(`could not locate ${path.join('.')} $value in the source text`)
  const edited = json.replace(pattern, `$1${next}$2`)
  // The pattern anchors on the leaf key alone, so a same-named key elsewhere in
  // the document would be edited instead. Re-parse and confirm the value moved
  // where it was asked to move: without this the probe would mutate the wrong
  // node and then blame the guard for not reacting.
  let check = JSON.parse(edited)
  for (const key of path) check = check?.[key]
  if (check?.$value !== next) {
    throw new Error(`the edit did not land on ${path.join('.')} (it reads ${JSON.stringify(check?.$value)})`)
  }
  return edited
}

/* ------------------------------------------------------------------ *
 * The pass
 * ------------------------------------------------------------------ */

function main() {
  const dir = buildHarness()
  console.log(`harness: ${dir}\n`)
  try {
    const pristine = new Map()
    for (const rel of [APP_CSS, TOKENS_JSON]) pristine.set(rel, read(dir, rel))

    const clean = runGuard(dir)
    record(
      'the harness is clean before any probe',
      clean.code === 0 && clean.violations.length === 0,
      `exit=${clean.code} violations=${clean.violations.length}` +
        (clean.violations.length ? `\n        ${clean.violations.map((v) => `${v.rule}: ${v.message}`).join('\n        ')}` : ''),
    )
    // `process.exit` here would skip the `finally` and leak the harness
    // directory, so stop by not entering the loop.
    if (clean.code !== 0) {
      console.log('\nThe guard does not pass on an unmutated tree, so no probe below would mean anything.')
    }

    for (const probe of clean.code === 0 ? probes : []) {
      const label = `${probe.id} (${probe.finding}) — ${probe.name}`
      const before = pristine.get(probe.file)
      let mutated
      try {
        mutated = probe.mutate(before, dir)
      } catch (err) {
        record(label, false, `the probe could not be applied: ${err.message}`)
        continue
      }
      if (mutated === before) {
        record(label, false, 'the probe changed nothing, so it proves nothing')
        continue
      }

      write(dir, probe.file, mutated)
      const run = runGuard(dir)
      write(dir, probe.file, before)

      const wantExit = probe.expectExit ?? 1
      const hits = probe.expect.rule ? run.violations.filter((v) => v.rule === probe.expect.rule) : []
      const wantCount = probe.expect.count ?? (probe.expect.rule ? 1 : 0)

      const exitOk = run.code === wantExit
      const countOk = probe.expect.rule ? hits.length === wantCount : true
      const messageOk = probe.expect.rule
        ? hits.some((v) => probe.expect.message.test(v.message))
        : probe.expect.message.test(run.text)

      const detail = probe.expect.rule
        ? `exit=${run.code} (want ${wantExit}); ${probe.expect.rule} fired ${hits.length}x (want ${wantCount})` +
          (hits.length
            ? `\n        ${hits.map((v) => `${v.line}:1  ${v.rule}  ${v.message}`).join('\n        ')}`
            : `\n        rules that did fire: ${[...new Set(run.violations.map((v) => v.rule))].join(', ') || 'none'}`)
        : `exit=${run.code} (want ${wantExit})\n        ${run.text.trim().split('\n').slice(-2).join('\n        ')}`

      record(label, exitOk && countOk && messageOk, detail)

      // The revert has to be proved too: a probe that leaves the guard red
      // makes every later probe meaningless.
      const after = runGuard(dir)
      record(`${probe.id} — the guard returns to green on revert`, after.code === 0, `exit=${after.code}`)
    }

    /* -------------------------------------------------------------- *
     * P6 / P7 — the raw-primitive ratchet
     * -------------------------------------------------------------- */

    const primitiveClean = runPrimitiveGuard(dir)
    record(
      'the primitive guard is clean before the raw-element probe',
      primitiveClean.code === 0,
      `exit=${primitiveClean.code}` +
        (primitiveClean.code === 0 ? '' : `\n        ${primitiveClean.text.trim().split('\n').slice(-4).join('\n        ')}`),
    )

    if (primitiveClean.code === 0) {
      // A brand-new surface with one hand-rolled button on it — token-correct,
      // focus-ring-correct, and still a second Button. Nothing in the tree gives
      // `components/probe` an allowance, so the ratchet has to refuse it.
      const probeFile = 'src/renderer/src/components/probe/RawElement.tsx'
      mkdirSync(dirname(join(dir, probeFile)), { recursive: true })
      writeFileSync(
        join(dir, probeFile),
        'export function RawElement() {\n' +
          '  return (\n' +
          '    <button type="button" className="focus-visible:focus-ring rounded-sm px-2 py-1">\n' +
          '      Do the thing\n' +
          '    </button>\n' +
          '  )\n' +
          '}\n',
      )

      const withRaw = runPrimitiveGuard(dir)
      record(
        'P6 — a raw `<button>` on a surface with no allowance fails the guard',
        withRaw.code === 1 && /no-raw-primitive/.test(withRaw.text),
        `exit=${withRaw.code} (want 1); no-raw-primitive named: ${/no-raw-primitive\] \d/.test(withRaw.text)}`,
      )

      const raised = runPrimitiveGuard(dir, ['--update-baseline'])
      record(
        'P7 — `--update-baseline` refuses to record the new element',
        raised.code === 2 && /does not raise it/.test(raised.text),
        `exit=${raised.code} (want 2)\n        ${raised.text.trim().split('\n')[0]}`,
      )
      record(
        'P7 — the refusal left the baseline untouched',
        read(dir, RAW_PRIMITIVE_BASELINE).includes('"counts": {}'),
        read(dir, RAW_PRIMITIVE_BASELINE).replace(/\s+/g, ' ').trim(),
      )

      rmSync(join(dir, probeFile), { force: true })
      const afterRaw = runPrimitiveGuard(dir)
      record(
        'P6 — the primitive guard returns to green on revert',
        afterRaw.code === 0,
        `exit=${afterRaw.code}`,
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  const failed = results.filter((r) => !r.ok)
  const ok = failed.length === 0
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`)
  if (!ok) {
    console.log('Failed:')
    for (const f of failed) console.log(`  - ${f.name}`)
    console.log(
      '\nA failure here means the guard no longer catches a defect it is trusted to catch.\n' +
        'Fix the guard — do not relax the probe.',
    )
  }
  process.exit(ok ? 0 : 1)
}

main()
