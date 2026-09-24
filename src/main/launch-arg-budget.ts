// How much an agent launch may put on its command line, per platform.
//
// A launch that is too long does not degrade: the kernel refuses the exec.
// Linux (and so WSL) caps any ONE argument at MAX_ARG_STRLEN, 32 pages
// (128 KiB), and the arguments and environment together at ARG_MAX; exec then
// fails with E2BIG, "Argument list too long". macOS has no per-argument cap but
// holds arguments and environment together to ARG_MAX, 1 MiB. Windows builds
// one command line for CreateProcess, capped at 32,767 UTF-16 code units, and
// the native launch hands that line to the CLI through an environment variable
// with the same cap.
//
// The budgets below sit well inside each limit, because the measurement is of
// the argv alone: the environment rides the same exec on POSIX, and a Windows
// npm shim re-quotes the line once more on its way to node. A launch that fits
// here fits there with room to spare.

export type LaunchArgPlatform = 'linux' | 'darwin' | 'windows'

export type LaunchArgBudget = {
  platform: LaunchArgPlatform
  /**
   * What a length is counted in: bytes of UTF-8 plus the terminating NUL (what
   * `execve` copies), or UTF-16 code units of the quoted command line (what
   * CreateProcess counts).
   */
  unit: 'utf8-bytes' | 'utf16-units'
  /** The most any one argument may take. */
  maxArg: number
  /** The most the whole argv may take. */
  maxTotal: number
}

const KIB = 1024

export const LAUNCH_ARG_BUDGETS: Readonly<Record<LaunchArgPlatform, LaunchArgBudget>> = {
  // 100 KiB against the 128 KiB MAX_ARG_STRLEN, and half a MiB of argv against
  // an ARG_MAX that is 2 MiB on a default stack but shared with the environment.
  linux: { platform: 'linux', unit: 'utf8-bytes', maxArg: 100 * KIB, maxTotal: 512 * KIB },
  // No per-argument cap on macOS; a quarter of the 1 MiB ARG_MAX, leaving the
  // rest to an environment that can be large when the app was started from a
  // shell.
  darwin: { platform: 'darwin', unit: 'utf8-bytes', maxArg: 256 * KIB, maxTotal: 256 * KIB },
  // 24K code units against the 32,767 CreateProcess allows, so the `-C <cwd>`
  // and `codex.js` path a Codex launch adds still fit. Not the 8,191 cmd.exe
  // allows: a runtime command that resolves to a `.cmd` shim is still bounded
  // by that, as it was before this budget existed.
  windows: { platform: 'windows', unit: 'utf16-units', maxArg: 24_000, maxTotal: 24_000 },
}

/**
 * The budget for a launch on `target`: a WSL launch execs inside Linux, a
 * native Windows one through CreateProcess, and a POSIX one on whatever this
 * machine is (every Unix other than macOS gets the Linux budget, the stricter).
 */
export function launchArgBudgetFor(
  target: 'posix' | 'wsl' | 'windows',
  platform: NodeJS.Platform = process.platform,
): LaunchArgBudget {
  if (target === 'windows') return LAUNCH_ARG_BUDGETS.windows
  if (target === 'wsl') return LAUNCH_ARG_BUDGETS.linux
  return platform === 'darwin' ? LAUNCH_ARG_BUDGETS.darwin : LAUNCH_ARG_BUDGETS.linux
}

// One argument as the MSVC runtime (CommandLineToArgvW) parses it back: quoted
// when it holds whitespace or a quote, `"` escaped, and the backslashes that
// run up to a quote doubled.
export function quoteWindowsCommandLineArg(value: string): string {
  if (value !== '' && !/[\s"]/.test(value)) return value
  let quoted = '"'
  let backslashes = 0
  for (const char of value) {
    if (char === '\\') {
      backslashes += 1
      continue
    }
    quoted += char === '"' ? `${'\\'.repeat(backslashes * 2 + 1)}"` : `${'\\'.repeat(backslashes)}${char}`
    backslashes = 0
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`
}

/** The size of one argument as `budget` counts it. */
export function measureLaunchArg(value: string, budget: LaunchArgBudget): number {
  if (budget.unit === 'utf16-units') return quoteWindowsCommandLineArg(value).length + 1
  return Buffer.byteLength(value, 'utf8') + 1
}

export type LaunchArgMeasurement = {
  /** The largest single argument, and where it sits in argv. */
  largest: number
  largestIndex: number
  total: number
}

export function measureLaunchArgv(argv: readonly string[], budget: LaunchArgBudget): LaunchArgMeasurement {
  let largest = 0
  let largestIndex = -1
  let total = 0
  argv.forEach((arg, index) => {
    const size = measureLaunchArg(arg, budget)
    total += size
    if (size > largest) {
      largest = size
      largestIndex = index
    }
  })
  return { largest, largestIndex, total }
}

/** True when this argv would be refused (or come close to it) on the budget's platform. */
export function launchArgvExceedsBudget(argv: readonly string[], budget: LaunchArgBudget): boolean {
  const measured = measureLaunchArgv(argv, budget)
  return measured.largest > budget.maxArg || measured.total > budget.maxTotal
}
