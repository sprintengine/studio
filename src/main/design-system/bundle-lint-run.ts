import { stat } from 'fs/promises'
import { join } from 'path'

import type { DesignSystemBundleLintRunResult } from '../../shared/design-system/bundle-lint-run'
import type { BundleScriptFork } from './derived-file-runner'

// On-demand run of a bundle's own scripts/lint.mjs, forked like every other
// bundle script. This is the studio release action's validating phase; the
// release pipeline (library-registry.ts) runs the same script again as its
// own gate, so a pass here is a preview, never a bypass. Exit contract of the
// template lint: 0 clean, 1 findings on stdout, anything else is
// misconfiguration.
export async function runDesignSystemBundleLint(
  bundleDir: string,
  fork: BundleScriptFork,
): Promise<DesignSystemBundleLintRunResult> {
  const lintPath = join(bundleDir, 'scripts', 'lint.mjs')
  try {
    await stat(lintPath)
  } catch {
    return {
      ok: false,
      kind: 'error',
      message: 'The bundle is missing its lint script (scripts/lint.mjs); it is not a complete design-system bundle.',
    }
  }
  const lint = await fork(lintPath, [bundleDir], { cwd: bundleDir })
  if (lint.exitCode === 0) return { ok: true }
  if (lint.exitCode === 1) {
    return { ok: false, kind: 'findings', findings: lint.stdout }
  }
  return {
    ok: false,
    kind: 'error',
    message: `The design-system lint could not run (exit ${lint.exitCode ?? 'none'}): ${
      lint.stderr.trim() || lint.stdout.trim() || 'no output'
    }`,
  }
}
