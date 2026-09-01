import { stat } from 'fs/promises';
import { join } from 'path';
// On-demand run of a bundle's own scripts/lint.mjs, forked like every other
// bundle script. This is the author's contribution gate — the guided-brief
// studio's validating preview is its only caller, and no read-only surface
// runs it. Exit contract of the template lint: 0 clean, 1 findings on stdout,
// anything else is misconfiguration.
export async function runDesignSystemBundleLint(bundleDir, fork) {
    const lintPath = join(bundleDir, 'scripts', 'lint.mjs');
    try {
        await stat(lintPath);
    }
    catch {
        return {
            ok: false,
            kind: 'error',
            message: 'The bundle is missing its lint script (scripts/lint.mjs); it is not a complete design-system bundle.',
        };
    }
    const lint = await fork(lintPath, [bundleDir], { cwd: bundleDir });
    if (lint.exitCode === 0)
        return { ok: true };
    if (lint.exitCode === 1) {
        return { ok: false, kind: 'findings', findings: lint.stdout };
    }
    return {
        ok: false,
        kind: 'error',
        message: `The design-system lint could not run (exit ${lint.exitCode ?? 'none'}): ${lint.stderr.trim() || lint.stdout.trim() || 'no output'}`,
    };
}
