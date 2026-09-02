#!/usr/bin/env node
// Bundle-scoped design-system lint — the mandatory contribution gate named in
// USAGE.md. Dependency-free Node ESM so any agent, in any repo, runs the same
// implementation that ships with the bundle:
//
//   node scripts/lint.mjs             # from the bundle root; exit 1 on violations
//   node scripts/lint.mjs --report    # report only, never fails
//   node scripts/lint.mjs <bundle>    # lint an explicit bundle root
//
// Rules over authored sources (components/**/*.css|html, patterns/*.html):
//   no-raw-hex            hex color literals — colors always come from tokens
//   no-untokenized-color  rgb()/hsl()/oklch()/color-mix()/hwb() literals
//   no-ref-variables      var(--ref-*): the ref tier is internal to the token
//                         file; components and patterns consume --sem-* only
//   no-raw-spacing        raw px/rem/em on padding, margin, or gap — spacing
//                         comes from sem.space.*; add a step rather than a
//                         local value
//   no-untokenized-font-family
//                         a font-family that is not sem.font.family.ui or
//                         .mono — the system ships two families, permanently
//   unknown-token-variable
//                         var(--sem-…) naming a variable foundations/tokens.css
//                         does not define. An undefined custom property makes
//                         the whole declaration invalid at computed-value time,
//                         so the property silently falls back to its initial
//                         value: `border-radius: var(--sem-radius-pill)` on an
//                         undeclared token rendered SQUARE, in three shipped
//                         components, for as long as the reference existed. The
//                         no-raw-* rules only police values that ARE spelled;
//                         this one polices a token that is named but is not
//                         there.
//
// Rules over foundations/tokens.tokens.json (every token, so new tokens cannot
// land without full semantic metadata):
//   missing-token-type        token without an explicit string $type
//   missing-token-description token without a non-empty $description
//   missing-token-semantics   sem.* token without $extensions["com.multicode"]
//                             carrying non-empty `role` and `use`
//   unresolved-token-alias    {dot.path} alias (in $value or modes) that does
//                             not resolve to a token in this file
//
// Escape hatch for legitimately un-tokenizable component values (e.g. a video
// overlay scrim that must be a literal): a `ds-lint-allow: <reason>` marker on
// the same line or one of the two preceding lines. The reason is mandatory.
// Token-metadata rules have no escape hatch — semantics are the contract.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ALLOW_MARKER = 'ds-lint-allow:'
const VENDOR_NAMESPACE = 'com.multicode'
const ALIAS_PATTERN = /^\{([a-z0-9.-]+)\}$/

// `#abc`..`#aabbccdd` used as a color literal. The lookbehind keeps URL
// anchors and entity references (`&#8594;`) out; \b keeps `#light` ids out.
const HEX_LITERAL = /(?<![\w#&])#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b/gi

// CSS color functions that bypass the token layer. Named keywords like
// `transparent` and `currentColor` are deliberately allowed.
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color-mix)\s*\(/g

// The ref tier is plumbing internal to foundations/tokens.css.
const REF_VARIABLE = /var\(\s*--ref-/g

// Spacing comes from sem.space.*. A raw px on padding/margin/gap means the
// scale is missing a step — add it to the tokens rather than locally. `0` is
// unitless and always allowed; so is any value that resolves through a var().
const RAW_SPACING =
  /\b(?:padding|margin|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?\s*:\s*[^;{}]*?\d+(?:\.\d+)?(?:px|rem|em)/g

// Two families, permanently: sem.font.family.ui and sem.font.family.mono.
// A third family — a serif especially — is a system change, not a style
// choice. `inherit` and `initial` are allowed; anything else must be a token.
// Every `--sem-*` a source READS. Compared against what tokens.css DECLARES;
// the difference is a token that does not exist. A fallback (`var(--x, 4px)`)
// still names --x, so the reference is checked either way.
const SEM_VARIABLE_REFERENCE = /var\(\s*(--sem-[\w-]+)/g

// The declarations in foundations/tokens.css, i.e. the names that resolve.
const SEM_VARIABLE_DECLARATION = /^\s*(--sem-[\w-]+)\s*:/gm

const UNTOKENIZED_FONT_FAMILY =
  /font-family\s*:\s*(?!\s*(?:var\(\s*--sem-font-family-|inherit|initial|unset)\b)[^;{}]+/g

const SOURCE_RULES = [
  { name: 'no-raw-hex', regex: HEX_LITERAL },
  { name: 'no-untokenized-color', regex: COLOR_FUNCTION },
  { name: 'no-ref-variables', regex: REF_VARIABLE },
  { name: 'no-raw-spacing', regex: RAW_SPACING },
  { name: 'no-untokenized-font-family', regex: UNTOKENIZED_FONT_FAMILY },
]

const SCAN_EXTENSIONS = new Set(['.css', '.html'])

class LintFailure extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

// Exit via stream flush: under Electron utilityProcess the parent IPC port
// keeps the event loop alive (the script never exits on its own) and a bare
// process.exit() truncates buffered pipe output. Flushing both stdio streams
// before the hard exit is correct under plain `node` too.
function exitAfterFlush(code) {
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)))
}

function collectSources(dir, out) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectSources(full, out)
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf('.')
      if (dot >= 0 && SCAN_EXTENSIONS.has(entry.name.slice(dot))) out.push(full)
    }
  }
  return out
}

function collectTokens(node, path, out) {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return out
  if ('$value' in node) {
    out.push({ path: path.join('.'), node })
    return out
  }
  for (const [key, child] of Object.entries(node)) collectTokens(child, [...path, key], out)
  return out
}

function main() {
  const args = process.argv.slice(2)
  const reportOnly = args.includes('--report')
  const rootArg = args.find((arg) => !arg.startsWith('--'))
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const bundleRoot = resolve(rootArg ?? join(scriptDir, '..'))

  if (!existsSync(join(bundleRoot, 'design-system.json'))) {
    throw new LintFailure(`Not a design-system bundle (no design-system.json): ${bundleRoot}`, 2)
  }

  const sourceFiles = [
    ...collectSources(join(bundleRoot, 'components'), []),
    ...collectSources(join(bundleRoot, 'patterns'), []),
  ].sort()

  // The generated stylesheet is the authority on which variables resolve: it is
  // what a consuming app actually loads. Read from the derived file rather than
  // from tokens.tokens.json so a stale build is caught too — a token added to
  // the source but never compiled does not resolve for anyone.
  const tokensCssPath = join(bundleRoot, 'foundations', 'tokens.css')
  if (!existsSync(tokensCssPath)) {
    throw new LintFailure(
      `Missing foundations/tokens.css in bundle: ${bundleRoot}. ` +
        'Run `node scripts/build-tokens.mjs` — unknown-token-variable has nothing to check against.',
      2,
    )
  }
  const declaredSemVariables = new Set(
    [...readFileSync(tokensCssPath, 'utf8').matchAll(SEM_VARIABLE_DECLARATION)].map((m) => m[1]),
  )

  let totalViolations = 0

  for (const filePath of sourceFiles) {
    const bundleRelative = relative(bundleRoot, filePath).split(sep).join('/')
    const lines = readFileSync(filePath, 'utf8').split('\n')
    const findings = []
    lines.forEach((line, index) => {
      if (line.includes(ALLOW_MARKER)) return
      if (index > 0 && lines[index - 1].includes(ALLOW_MARKER)) return
      if (index > 1 && lines[index - 2].includes(ALLOW_MARKER)) return
      for (const rule of SOURCE_RULES) {
        rule.regex.lastIndex = 0
        let match
        while ((match = rule.regex.exec(line))) {
          findings.push({
            rule: rule.name,
            line: index + 1,
            column: match.index + 1,
            text: match[0],
          })
        }
      }
      SEM_VARIABLE_REFERENCE.lastIndex = 0
      let reference
      while ((reference = SEM_VARIABLE_REFERENCE.exec(line))) {
        if (declaredSemVariables.has(reference[1])) continue
        findings.push({
          rule: 'unknown-token-variable',
          line: index + 1,
          column: reference.index + 1,
          text: `${reference[1]} is not declared in foundations/tokens.css`,
        })
      }
    })
    if (findings.length > 0) {
      totalViolations += findings.length
      process.stdout.write(`\n${bundleRelative}\n`)
      for (const finding of findings) {
        process.stdout.write(`  ${finding.line}:${finding.column}  ${finding.rule}  ${finding.text}\n`)
      }
    }
  }

  // --- Token metadata guard --------------------------------------------------

  const TOKENS_RELATIVE = 'foundations/tokens.tokens.json'
  const tokensPath = join(bundleRoot, 'foundations', 'tokens.tokens.json')
  if (!existsSync(tokensPath)) {
    throw new LintFailure(`Missing ${TOKENS_RELATIVE} in bundle: ${bundleRoot}`, 2)
  }

  let tokensDocument
  try {
    tokensDocument = JSON.parse(readFileSync(tokensPath, 'utf8'))
  } catch (error) {
    throw new LintFailure(`${TOKENS_RELATIVE} is not valid JSON: ${error.message}`, 2)
  }

  const tokens = collectTokens(tokensDocument, [], [])
  const tokenPaths = new Set(tokens.map((token) => token.path))
  const tokenFindings = []

  function checkAlias(value, tokenPath, context) {
    if (typeof value !== 'string') return
    const alias = ALIAS_PATTERN.exec(value)
    if (alias && !tokenPaths.has(alias[1])) {
      tokenFindings.push({
        path: tokenPath,
        rule: 'unresolved-token-alias',
        text: `${context} alias ${value} resolves to no token`,
      })
    }
  }

  for (const token of tokens) {
    const { $type, $description, $extensions } = token.node
    if (typeof $type !== 'string' || $type.length === 0) {
      tokenFindings.push({ path: token.path, rule: 'missing-token-type', text: 'no explicit $type' })
    }
    if (typeof $description !== 'string' || $description.trim().length === 0) {
      tokenFindings.push({ path: token.path, rule: 'missing-token-description', text: 'no $description' })
    }
    const vendor =
      typeof $extensions === 'object' && $extensions !== null ? $extensions[VENDOR_NAMESPACE] : undefined
    if (token.path.startsWith('sem.')) {
      const role = typeof vendor === 'object' && vendor !== null ? vendor.role : undefined
      const use = typeof vendor === 'object' && vendor !== null ? vendor.use : undefined
      if (typeof role !== 'string' || role.length === 0 || typeof use !== 'string' || use.length === 0) {
        tokenFindings.push({
          path: token.path,
          rule: 'missing-token-semantics',
          text: `sem token needs $extensions["${VENDOR_NAMESPACE}"] with role and use`,
        })
      }
    }
    checkAlias(token.node.$value, token.path, '$value')
    const modes = typeof vendor === 'object' && vendor !== null ? vendor.modes : undefined
    if (typeof modes === 'object' && modes !== null) {
      for (const [mode, value] of Object.entries(modes)) checkAlias(value, token.path, `modes.${mode}`)
    }
  }

  if (tokenFindings.length > 0) {
    totalViolations += tokenFindings.length
    process.stdout.write(`\n${TOKENS_RELATIVE}\n`)
    for (const finding of tokenFindings) {
      process.stdout.write(`  ${finding.path}  ${finding.rule}  ${finding.text}\n`)
    }
  }

  process.stdout.write('\nDesign-system lint summary\n')
  process.stdout.write(`  bundle: ${bundleRoot}\n`)
  process.stdout.write(`  scanned: ${sourceFiles.length} component/pattern files, ${tokens.length} tokens\n`)
  process.stdout.write(`Total violations: ${totalViolations}\n`)

  if (totalViolations > 0) {
    process.stdout.write(
      '\nFix by reading every value from the --sem-* custom properties in\n' +
        'foundations/tokens.css: colors from --sem-color-*, padding/margin/gap\n' +
        'from --sem-space-*, and font-family from --sem-font-family-ui or\n' +
        '--sem-font-family-mono (the system ships two families, permanently).\n' +
        'A missing spacing step belongs in the token source, not in a component.\n' +
        'Give every token an explicit $type, a $description, and (for sem.*\n' +
        'tokens) $extensions["com.multicode"] with role and use — see USAGE.md.\n' +
        'Document a legitimately un-tokenizable component value with a\n' +
        '`ds-lint-allow: <reason>` marker on the same line or one of the two\n' +
        'lines above it.\n',
    )
  }

  return !reportOnly && totalViolations > 0 ? 1 : 0
}

try {
  exitAfterFlush(main())
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  exitAfterFlush(error instanceof LintFailure ? error.code : 1)
}
