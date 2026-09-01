import { app } from 'electron';
import { access } from 'fs/promises';
import { join } from 'path';
// Resolves the built-in "seed from the Multicode brand" demo source for the
// design-system preset. The demo reads knowledge/brand/ from the Multicode
// repo itself (the epic's dogfood reference system), which exists in dev
// checkouts but is not shipped as an extraResource — so packaged builds
// resolve to unavailable and the wizard shows the demo option disabled with
// that cause instead of seeding from an invented path.
export async function resolveDesignSystemBrandDemoSeedDir() {
    const candidate = join(app.getAppPath(), 'knowledge', 'brand');
    try {
        await access(candidate);
        return { ok: true, path: candidate };
    }
    catch {
        // Kept short: the wizard renders this verbatim as the demo card's body
        // copy, which has roughly two 12px lines before the card clips.
        return {
            ok: false,
            message: 'The demo source (knowledge/brand/) is not bundled with this build.',
        };
    }
}
