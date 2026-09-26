export type CommandKind =
  | 'run'
  | 'read'
  | 'search'
  | 'list'
  | 'edit'
  | 'write'
  | 'git'
  | 'test'
  | 'build'
  | 'install'
  | 'lint'
  | 'format'
  | 'network'
  | 'script'
export type CommandLabel = { label: string; program: string; kind: CommandKind; target?: string }

type Token = { value: string; operator: boolean }
const SEPARATORS = new Set(['&&', '||', ';', '|', '&', '\n'])
const SETUP = new Set(['cd', 'pushd', 'export', 'set', 'source', '.', 'unset', 'ulimit', 'umask'])
const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'nl'])
const SEARCHERS = new Set(['rg', 'grep', 'ag', 'ack'])
const LISTERS = new Set(['ls', 'tree', 'exa', 'eza'])
const INTERPRETERS = new Set(['node', 'python', 'python3', 'ruby', 'deno', 'bun', 'tsx', 'ts-node'])

function tokenize(input: string): Token[] {
  const result: Token[] = []
  let word = ''
  let quoted = false
  let quote: "'" | '"' | null = null
  const push = () => {
    if (word || quoted) result.push({ value: word, operator: false })
    word = ''
    quoted = false
  }
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (quote) {
      if (char === quote) {
        quote = null
        continue
      }
      if (char === '\\' && quote === '"' && i + 1 < input.length) {
        word += input[++i]
      } else word += char
      continue
    }
    if (char === '\\' && i + 1 < input.length) {
      word += input[++i]
      continue
    }
    if (char === '$' && input[i + 1] === "'") {
      word += '$'
      quote = "'"
      i++
      quoted = true
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      quoted = true
      continue
    }
    if (/\s/u.test(char)) {
      push()
      if (char === '\n') result.push({ value: '\n', operator: true })
      continue
    }
    if (';&|<>'.includes(char)) {
      push()
      const pair = char + (input[i + 1] ?? '')
      if (['&&', '||', '>>', '<<'].includes(pair)) {
        result.push({ value: pair, operator: true })
        i++
      } else result.push({ value: char, operator: true })
      continue
    }
    word += char
  }
  push()
  return result
}

function basename(path: string): string {
  const name = path.split(/[\\/]/u).at(-1) ?? path
  return name || path
}

function programName(path: string): string {
  return basename(path).replace(/\.(?:exe|cmd|bat|sh|ps1)$/iu, '')
}

function shorten(value: string, max = 60): string {
  if (value.length <= max) return value
  const left = Math.ceil((max - 1) / 2)
  return `${value.slice(0, left)}…${value.slice(-(max - left - 1))}`
}

function labeled(label: string, program: string, kind: CommandKind, target?: string): CommandLabel {
  return { label: shorten(label), program, kind, ...(target ? { target } : {}) }
}

function inferScriptKind(script: string): CommandKind {
  if (/test|spec|check/u.test(script)) return 'test'
  if (/build|compile|bundle/u.test(script)) return 'build'
  if (/lint/u.test(script)) return 'lint'
  if (/format|prettier/u.test(script)) return 'format'
  return 'script'
}

function firstSegment(tokens: Token[]): Token[] {
  let current: Token[] = []
  const segments: Token[][] = []
  for (const token of tokens) {
    if (token.operator && SEPARATORS.has(token.value)) {
      if (current.length) segments.push(current)
      current = []
    } else current.push(token)
  }
  if (current.length) segments.push(current)
  return (
    segments.find((segment) => {
      const words = segment.filter((token) => !token.operator).map((token) => token.value)
      const first = words.find((word) => !/^[A-Za-z_][A-Za-z_0-9]*=/u.test(word))
      return first && !SETUP.has(programName(first))
    }) ?? []
  )
}

function stripWrappers(words: string[]): string[] {
  let args = words
  for (let loops = 0; loops < 12 && args.length; loops++) {
    const first = programName(args[0])
    if (/^[A-Za-z_][A-Za-z_0-9]*=/u.test(args[0])) {
      args = args.slice(1)
      continue
    }
    if (first === 'env') {
      args = args.slice(1)
      while (args[0]?.startsWith('-') || /^[A-Za-z_][A-Za-z_0-9]*=/u.test(args[0] ?? '')) args = args.slice(1)
      continue
    }
    if (['sudo', 'time', 'nohup', 'command', 'exec', 'caffeinate'].includes(first)) {
      args = args.slice(1)
      if (first === 'sudo' || first === 'caffeinate') while (args[0]?.startsWith('-')) args = args.slice(1)
      continue
    }
    if (first === 'nice') {
      args = args.slice(1)
      if (args[0] === '-n') args = args.slice(2)
      else if (args[0]?.startsWith('-')) args = args.slice(1)
      continue
    }
    if (first === 'timeout') {
      args = args.slice(2)
      continue
    }
    if (first === 'arch') {
      args = args[1]?.startsWith('-') ? args.slice(2) : args.slice(1)
      continue
    }
    if (first === 'stdbuf') {
      args = args.slice(1)
      while (args[0]?.startsWith('-')) args = args.slice(1)
      continue
    }
    break
  }
  return args
}

function targetAfterOptions(args: string[]): string[] {
  return args.filter((arg) => !arg.startsWith('-') && arg !== '--')
}

function classify(
  words: string[],
  operators: Token[],
  depth: number,
  shell: 'posix' | 'powershell' | 'cmd',
): CommandLabel {
  const args = stripWrappers(words)
  if (!args.length) return labeled('Ran command', '', 'run')
  const program = programName(args[0])
  const lower = program.toLowerCase()

  if (depth < 3 && ['bash', 'sh', 'zsh', 'fish', 'powershell', 'pwsh'].includes(lower)) {
    const flag = args.findIndex((arg) => ['-c', '-lc', '-Command', '-command'].includes(arg))
    if (flag >= 0 && args[flag + 1])
      return labelCommandInner(
        args[flag + 1],
        depth + 1,
        lower === 'pwsh' || lower === 'powershell' ? 'powershell' : shell,
      )
  }

  let runnerTool: string | undefined
  if (lower === 'npx' || lower === 'bunx' || lower === 'uvx') runnerTool = args[1]
  else if (lower === 'pipx' && args[1] === 'run') runnerTool = args[2]
  else if (['pnpm', 'yarn'].includes(lower) && args[1] === 'dlx') runnerTool = args[2]
  if (runnerTool) {
    const tool = runnerTool.replace(/@[^@/]+$/u, '')
    return classify([tool, ...args.slice(args.indexOf(runnerTool) + 1)], operators, depth + 1, shell)
  }

  if (lower === 'bun' && /\.[A-Za-z0-9]+$/u.test(args[1] ?? '') && args[1] !== 'run') {
    return labeled(`Ran ${basename(args[1])}`, lower, 'script', args[1])
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(lower)) {
    const script = args[1] === 'run' ? args[2] : args[1]
    if (script && (args[1] === 'run' || !['install', 'add', 'remove', 'exec', 'dlx'].includes(script))) {
      return labeled(`Ran ${lower} script ${script}`, lower, inferScriptKind(script), script)
    }
    if (['install', 'add'].includes(script))
      return labeled(`Installed ${args[2] ?? 'dependencies'}`, lower, 'install', args[2])
  }

  if (lower === 'git') {
    let i = 1
    while (i < args.length && (args[i] === '-C' || args[i] === '-c')) i += 2
    return labeled(`git ${args[i] ?? 'command'}`, 'git', 'git', args[i])
  }

  if (['echo', 'printf'].includes(lower)) {
    const redirect = operators.findIndex((token) => token.operator && ['>', '>>'].includes(token.value))
    const target = redirect >= 0 ? operators[redirect + 1]?.value : undefined
    if (target) return labeled(`Wrote ${basename(target)}`, lower, 'write', target)
  }

  if (INTERPRETERS.has(lower)) {
    const offset = lower === 'deno' && args[1] === 'run' ? 2 : 1
    if (args[offset] === '-e' || args[offset] === '-c') return labeled(`Ran ${lower} snippet`, lower, 'script')
    if (operators.some((token) => token.value === '<<')) return labeled(`Ran ${lower} script`, lower, 'script')
    const file = targetAfterOptions(args.slice(offset))[0]
    return file ? labeled(`Ran ${basename(file)}`, lower, 'script', file) : labeled(`Ran ${lower}`, lower, 'run')
  }

  if ((lower === 'cat' || lower === 'tee') && operators.some((token) => token.value === '<<')) {
    const redirect = operators.findIndex((token) => token.value === '>')
    const target = lower === 'tee' ? args[1] : operators[redirect + 1]?.value
    if (target) return labeled(`Wrote ${basename(target)}`, lower, 'write', target)
  }

  const powershellMap: Record<string, [CommandKind, string]> = {
    'get-content': ['read', 'Read'],
    gc: ['read', 'Read'],
    'set-content': ['write', 'Wrote'],
    'out-file': ['write', 'Wrote'],
    'add-content': ['write', 'Wrote'],
    'get-childitem': ['list', 'Listed'],
    gci: ['list', 'Listed'],
    'select-string': ['search', 'Searched for'],
    sls: ['search', 'Searched for'],
    'remove-item': ['edit', 'Deleted'],
    ri: ['edit', 'Deleted'],
  }
  if (shell === 'powershell' || powershellMap[lower]) {
    const mapped = powershellMap[lower]
    if (mapped) {
      const target = targetAfterOptions(args.slice(1))[0] ?? '.'
      return labeled(`${mapped[1]} ${basename(target)}`, program, mapped[0], target)
    }
  }

  if (READERS.has(lower) || (lower === 'sed' && args[1] === '-n')) {
    const files = targetAfterOptions(args.slice(lower === 'sed' ? 3 : 1))
    if (files.length > 1) return labeled(`Read ${files.length} files`, program, 'read')
    return labeled(`Read ${basename(files[0] ?? 'input')}`, program, 'read', files[0])
  }
  if (SEARCHERS.has(lower)) {
    const patterns = targetAfterOptions(args.slice(1))
    const pattern = shorten(patterns[0] ?? '', 40)
    return labeled(pattern ? `Searched for "${pattern}"` : 'Searched files', program, 'search', patterns[0])
  }
  if (lower === 'find' || lower === 'fd') return labeled('Searched files', program, 'search')
  if (LISTERS.has(lower)) {
    const dir = targetAfterOptions(args.slice(1))[0] ?? '.'
    return labeled(`Listed ${dir}`, program, 'list', dir)
  }
  if (['curl', 'wget', 'fetch'].includes(lower)) return labeled(`Ran ${program}`, program, 'network')
  if (['vitest', 'jest', 'pytest', 'mocha'].includes(lower)) return labeled(`Ran ${program}`, program, 'test')
  if (['eslint', 'oxlint'].includes(lower)) return labeled(`Ran ${program}`, program, 'lint')
  if (['prettier'].includes(lower)) return labeled(`Ran ${program}`, program, 'format')
  return labeled(`Ran ${program || 'command'}`, program, 'run')
}

function labelCommandInner(
  input: string | string[],
  depth: number,
  shell: 'posix' | 'powershell' | 'cmd',
): CommandLabel {
  const tokens = Array.isArray(input) ? input.map((value) => ({ value, operator: false })) : tokenize(input)
  const segment = firstSegment(tokens)
  const words = segment.filter((token) => !token.operator).map((token) => token.value)
  return classify(words, segment, depth, shell)
}

export function labelCommand(
  input: string | string[],
  opts: { shell?: 'posix' | 'powershell' | 'cmd' } = {},
): CommandLabel {
  try {
    return labelCommandInner(input, 0, opts.shell ?? 'posix')
  } catch {
    return labeled('Ran command', '', 'run')
  }
}
