import { readdir, readlink, realpath } from 'fs/promises';
import { isAbsolute, join, relative, sep } from 'path';
// Bundle sources are user-browsable folders, so a hostile bundle can ship
// symlinks pointing at secrets outside itself (foundations/tokens.css ->
// ~/.aws/credentials). Attach copies the tree verbatim (fs.cp keeps links,
// dereference:false), so it refuses — fail closed, nothing materialized —
// any bundle whose tree contains a symlink that is not provably confined:
//
// - an absolute link target escapes the copy even when it points inside the
//   source bundle (the copied link would still resolve to the source), so
//   absolute links are refused outright;
// - a relative link whose realpath resolves outside the bundle (../ chains)
//   is refused;
// - a link whose target cannot be resolved is refused (it cannot be proven
//   confined).
//
// Relative links that resolve inside the bundle are allowed: they stay
// confined after a verbatim copy because the relative structure is preserved.
/**
 * Walk a bundle directory and return the bundle-relative path of the first
 * symlink that is not confined to the bundle, or null when the whole tree is
 * safe to copy verbatim.
 */
export async function findEscapingSymlink(bundleDir) {
    const base = await realpath(bundleDir);
    return walkForEscapingSymlink(base, base);
}
async function walkForEscapingSymlink(base, dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const entryPath = join(dir, entry.name);
        if (entry.isSymbolicLink()) {
            const bundleRelative = relative(base, entryPath);
            let linkTarget;
            try {
                linkTarget = await readlink(entryPath);
            }
            catch {
                return bundleRelative;
            }
            if (isAbsolute(linkTarget))
                return bundleRelative;
            try {
                const resolved = await realpath(entryPath);
                if (resolved !== base && !resolved.startsWith(base + sep))
                    return bundleRelative;
            }
            catch {
                return bundleRelative;
            }
        }
        else if (entry.isDirectory()) {
            const escaping = await walkForEscapingSymlink(base, entryPath);
            if (escaping !== null)
                return escaping;
        }
    }
    return null;
}
