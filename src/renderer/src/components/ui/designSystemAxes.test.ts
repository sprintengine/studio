import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// MC-2119 — the ratchet.
//
// Color hygiene in this renderer is near-perfect (a handful of non-test hex
// literals, most of them theme-blind canvases and brand marks) and px font
// sizes are effectively gone. Not because anyone is more careful about color:
// because `designSystemConformance.test.tsx` and the token lint POLICE color,
// and nothing polices the rest. The unpoliced axes are exactly where the
// off-ramps live, and nothing stopped the count growing.
//
// So this file is deliberately not a "fix everything" gate. It is two kinds of
// assertion, per the shape MC-2119 asks for:
//
//   HARD RULES — the kit (`components/ui/`) consumes the token, full stop.
//     A primitive that spells a shadow, a stacking tier or a type step by hand
//     is not a primitive; every host that copies it inherits the off-ramp.
//     These are at zero and must stay there.
//
//   RATCHETS — the app tree carries a checked-in per-directory count.
//     Going DOWN is a one-line edit to the baseline below. Going UP fails, and
//     names the directory. This is how ~476 radius off-ramps drain without a
//     big-bang sweep that would touch every file in the renderer at once.
//
// The counts are read from source text rather than from a rendered tree on
// purpose: these are repo-wide questions ("how many places spell a radius by
// hand"), and mounting every component to ask them is neither possible nor
// useful. The rendered-class contracts stay in `designSystemConformance.test.tsx`.
//
// The epic's exit condition is every baseline at zero.

const RENDERER = join(process.cwd(), 'src/renderer/src')
const KIT = join(RENDERER, 'components/ui')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      walk(full, out)
    } else if (/\.(tsx|ts)$/.test(name) && !/\.test\./.test(name)) {
      out.push(full)
    }
  }
  return out
}

/**
 * Comments are stripped before scanning. Without this, prose describing an
 * off-ramp counts as one — `Modal.tsx`'s own ladder comment scored four bare
 * `z-*` hits while the file used none — so documenting a rule would make the
 * rule look violated, and deleting the documentation would "fix" it.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

/** The directory a count is attributed to: `components/<area>`, else top level. */
function area(file: string): string {
  const parts = relative(RENDERER, file).split('/')
  if (parts[0] !== 'components') return parts[0]
  return parts.length > 1 ? `components/${parts[1]}` : 'components'
}

const AXES = {
  /**
   * Tailwind-native radius steps are 2/4/6/8/12/16px — none of them on the
   * system's 3/5/7/9 ramp. Matching the literal `rounded-[5px]` is deliberately
   * NOT a violation today (it is the token's value) but it will not move if the
   * ramp moves, which is why the ramp radii are the target rather than the ban.
   * `rounded-full` and `rounded-[…]` are excluded: a pill and an explicit value
   * are decisions, not defaults.
   */
  radius: /(?:^|["'\s`])-?rounded(?:-(?:[tblr]|[tb][lr]))?(?:-(?:xs|sm|md|lg|xl|2xl|3xl))?(?=["'\s`])/g,
  /**
   * A shadow spelled with a color literal rather than a token. `transparent`
   * and `var(--…)` are fine — the failure mode is a TUNED color, because the
   * one that shipped was the dark-mode drawer value hardcoded into five
   * light-and-dark overlays.
   */
  shadow: /shadow-\[[^\]]*(?:rgba?\(|#[0-9a-fA-F]{3,8})[^\]]*\]/g,
  /** A stacking tier as a bare number, utility or arbitrary. */
  z: /(?:^|["'\s`])z-(?:\d+|\[\d+\])(?=["'\s`])/g,
  /** Tailwind's own type scale, sidestepping micro/meta/body/heading/title. */
  type: /(?:^|["'\s`])text-(?:xs|sm|base|lg|xl|2xl|3xl)(?=["'\s`])/g,
  /** Square boxes that should be on the `icon-*` / `size-icon-*` ramp. */
  icon: /(?:^|["'\s`])(?:size-(?:3|3\.5|4|5|6)|h-(?:3|3\.5|4|5|6) w-(?:3|3\.5|4|5|6))(?=["'\s`])/g,
} as const

type Axis = keyof typeof AXES

/**
 * Today's measured counts, 2026-08-05. ONLY EVER EDIT THESE DOWNWARD.
 *
 * A directory absent from an axis is asserted at zero, so a new off-ramp in a
 * clean directory fails too — otherwise the ratchet would only police the
 * directories that already had a problem.
 */
const BASELINE: Record<Axis, Record<string, number>> = {
  radius: {
    'components/workspace': 197,
    'components/panels': 173,
    'components/settings': 36,
    'components/backlog': 21,
    // Rose 15 → 17 when CommandPalette MOVED into the kit (MC-2117) carrying its
    // own two radii. Nothing regressed; the debt changed address.
    'components/ui': 17,
    'components/worktree': 9,
    'components/diagnostics': 7,
    utils: 4,
    'components/automations': 2,
    'components/auxWindows': 2,
    'components/learn': 2,
    modules: 2,
    review: 2,
  },
  // `utils/highlight.ts` is 14 of the 17: per-language terminal highlight rings,
  // each a tuned inset glow in the language's own hue. They are content colour
  // rather than surface elevation, and they have no token because the system
  // does not ship a language palette — recorded here rather than allowlisted,
  // so they stay visible as a debt with a known reason.
  shadow: {
    utils: 14,
    'components/workspace': 3,
  },
  z: {
    'components/workspace': 18,
    'components/panels': 14,
    'components/ui': 3,
    'components/memory': 2,
    'components/auxWindows': 1,
    'components/backlog': 1,
    'components/onboarding': 1,
  },
  type: {
    'components/panels': 23,
    utils: 6,
    'components/diagnostics': 2,
  },
  icon: {
    'components/workspace': 44,
    'components/panels': 31,
    'components/ui': 22,
    'components/backlog': 8,
    'components/auxWindows': 1,
    'components/brand': 1,
    'components/settings': 1,
    review: 1,
  },
}

/**
 * Hard rules: axes the KIT must be at zero on, forever.
 *
 * Radius and icon size are deliberately absent. The kit still spells 15 radii
 * and 22 icon boxes by hand; those drain through the ratchet with everything
 * else rather than being declared a hard rule the code does not yet meet, which
 * would only mean a red suite or a fat allowlist.
 */
const KIT_HARD_RULES: Axis[] = ['shadow', 'z', 'type']

/**
 * Kit files exempt from the `z` hard rule, each with its reason on the record.
 *
 * The rule is about OVERLAY LAYERS — surfaces that stack against each other
 * across the app. These three express depth WITHIN their own pane, which the
 * overlay ladder has nothing to say about; giving them `--z-popover` would
 * claim a global tier none of them wants.
 */
const Z_HARD_RULE_EXEMPT: Record<string, string> = {
  'SidePane.tsx': 'z-20: the resize handle above its own pane, not an overlay layer',
  'SkillPickerPopover.tsx': 'z-30: anchored inside a composer, the app panel-internal tier',
  'TerminalReplaySkeleton.tsx': 'z-10: a skeleton over its own terminal, not a layer',
}

function countsFor(files: string[], axis: Axis): Map<string, number> {
  const byArea = new Map<string, number>()
  for (const file of files) {
    const found = code(file).match(AXES[axis])
    if (!found) continue
    byArea.set(area(file), (byArea.get(area(file)) ?? 0) + found.length)
  }
  return byArea
}

function offendersFor(files: string[], axis: Axis, targetArea: string): string[] {
  return files
    .filter((file) => area(file) === targetArea && AXES[axis].test(code(file)))
    .map((file) => relative(RENDERER, file))
}

let failures = 0
function run(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

const rendererFiles = walk(RENDERER)
const kitFiles = walk(KIT)

// ── hard rules ───────────────────────────────────────────────────────────────

for (const axis of KIT_HARD_RULES) {
  run(`the kit spells no ${axis} by hand`, () => {
    const offenders: string[] = []
    for (const file of kitFiles) {
      const name = file.split('/').pop() ?? ''
      if (axis === 'z' && name in Z_HARD_RULE_EXEMPT) continue
      const found = code(file).match(AXES[axis])
      if (found) offenders.push(`${relative(RENDERER, file)} → ${found.join(', ')}`)
    }
    assert.deepEqual(
      offenders,
      [],
      `a primitive that spells its own ${axis} exports the off-ramp to every host that copies it`,
    )
  })
}

run('every overlay layer in the kit resolves to the one ladder', () => {
  // The ladder of record is the bundle's `--sem-z-*`, aliased as `--z-*`
  // (assets/index.css). Before this there were two: the tokens said modal 70,
  // and `Modal.tsx` documented and used its own with modal at z-50 — a tier
  // BELOW the menus, so a context menu opened over a dialog painted on top of
  // it. Asserted per surface, because "no bare numbers" alone would pass a file
  // that simply stopped stacking.
  const OVERLAYS: Record<string, string> = {
    'Modal.tsx': '--z-modal',
    'Drawer.tsx': '--z-drawer',
    'Popover.tsx': '--z-popover',
    'Tooltip.tsx': '--z-popover',
    'CursorErrorPopover.tsx': '--z-popover',
    'ContextMenu.tsx': '--z-menu',
    'PointerPopover.tsx': '--z-menu',
  }
  for (const [file, token] of Object.entries(OVERLAYS)) {
    const source = code(join(KIT, file))
    assert.ok(source.includes(token), `${file} stacks on ${token}, not on a number that happens to match it`)
  }
})

run('the ladder the kit consumes is the one the bundle publishes', () => {
  // The `--z-*` aliases must actually resolve to `--sem-z-*`. Without this the
  // kit could consume a second ladder that merely looked like the first.
  const appCss = readFileSync(join(RENDERER, 'assets/index.css'), 'utf8')
  for (const tier of ['sticky', 'drawer', 'popover', 'menu', 'modal', 'toast']) {
    assert.match(
      appCss,
      new RegExp(`--z-${tier}:\\s*var\\(--sem-z-${tier}\\)`),
      `--z-${tier} aliases the bundle's tier rather than restating a number`,
    )
  }
})

run('overlay elevation comes from a shadow token, in both themes', () => {
  // Five kit overlays hardcoded `0 8px 24px -12px rgba(0,0,0,0.6)`, which is
  // literally the value `--sem-shadow-drawer` takes in DARK mode — so every
  // light-theme popover cast a shadow tuned for a dark one, and
  // `--sem-shadow-popover` went unconsumed entirely.
  for (const file of ['Popover.tsx', 'PointerPopover.tsx', 'ContextMenu.tsx', 'CursorErrorPopover.tsx', 'SkillPickerPopover.tsx']) {
    assert.match(
      code(join(KIT, file)),
      /shadow-\[var\(--shadow-popover\)\]/,
      `${file} takes its elevation from the popover token, which is defined per theme`,
    )
  }
})

// ── ratchets ─────────────────────────────────────────────────────────────────

for (const axis of Object.keys(AXES) as Axis[]) {
  run(`${axis}: no directory grows a new off-ramp`, () => {
    const actual = countsFor(rendererFiles, axis)
    const baseline = BASELINE[axis]
    const areas = new Set([...Object.keys(baseline), ...actual.keys()])
    const grew: string[] = []
    const shrank: string[] = []
    for (const dir of areas) {
      const now = actual.get(dir) ?? 0
      const then = baseline[dir] ?? 0
      if (now > then) {
        const named = offendersFor(rendererFiles, axis, dir).slice(0, 6)
        grew.push(`${dir}: ${then} → ${now}  (files: ${named.join(', ')})`)
      } else if (now < then) {
        shrank.push(`${dir}: ${then} → ${now}`)
      }
    }
    assert.deepEqual(
      grew,
      [],
      `new ${axis} off-ramps. Use the token ramp, or if this is deliberate, say why in BASELINE`,
    )
    // Going down is the point — but a stale baseline hides the next regression
    // under the slack it leaves, so it has to be spent rather than banked.
    assert.deepEqual(
      shrank,
      [],
      `${axis} off-ramps went DOWN — good. Lower these numbers in BASELINE to lock the win in`,
    )
  })
}

run('every policed axis has a baseline, and the exit is all of them at zero', () => {
  for (const axis of Object.keys(AXES) as Axis[]) {
    assert.ok(axis in BASELINE, `${axis} is scanned, so it must carry a baseline`)
  }
  const remaining = Object.entries(BASELINE).map(
    ([axis, dirs]) => `${axis} ${Object.values(dirs).reduce((a, b) => a + b, 0)}`,
  )
  console.log(`   remaining off-ramps — ${remaining.join(', ')}`)
})

if (failures > 0) {
  console.error(`\ndesignSystemAxes.test.ts: ${failures} failing`)
  process.exit(1)
}
console.log('design system axes: all checks passed')
